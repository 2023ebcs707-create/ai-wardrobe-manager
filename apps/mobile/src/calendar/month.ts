/**
 * The calendar's date arithmetic, kept away from the components that render it
 * so it can be asserted directly. Nothing here touches the API or React.
 *
 * EVERYTHING IN THIS FILE IS LOCAL TIME, deliberately.
 *
 * `PublicWearEvent.wornAt` is an ISO instant, but "what did I wear on the 28th"
 * is a question about the user's own calendar, not about UTC. A wear logged at
 * 6pm in Delhi is a wear on that date to the person who logged it, and grouping
 * it by its UTC date would file roughly a quarter of every evening's outfits on
 * the wrong day — visibly wrong on a screen whose entire job is a month grid.
 *
 * This matches how the rest of the app already reads dates: `app/items/[id].tsx`
 * formats `createdAt` with the local getters, and `jest.config.js` pins
 * `TZ=America/Los_Angeles` precisely so a UTC implementation and a local one
 * are told apart rather than coinciding.
 */
import type { PublicWearEvent } from '@wardrobe/shared';

/** `YYYY-MM-DD` in the device's own zone. The key everything here is keyed by. */
export function localDayKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** The local day a wear belongs to. */
export function dayKeyOf(wornAt: string): string {
  return localDayKey(new Date(wornAt));
}

/** `YYYY-MM-DD` -> the local midnight it names, for formatting a weekday. */
export function dateFromDayKey(key: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (match === null) return null;
  const [, y, m, d] = match;
  // Constructed from parts, never `new Date('2026-08-28')` — a bare date
  // string is parsed as UTC midnight by the spec, which in any negative
  // offset is the *previous* day locally. That is the same class of bug this
  // whole module exists to avoid.
  const date = new Date(Number(y), Number(m) - 1, Number(d));
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * The cells of a month grid, weeks starting Monday.
 *
 * `null` is a leading blank before the 1st. There is no trailing padding: a
 * grid laid out by a 7-column flex wrap does not need cells to finish the last
 * row, and rendering invisible buttons there is how a screen reader ends up
 * announcing four empty items.
 */
export function monthCells(year: number, month: number): (number | null)[] {
  const first = new Date(year, month, 1);
  // `getDay()` is 0=Sunday; this app's grid starts on Monday.
  const lead = (first.getDay() + 6) % 7;
  // Day 0 of the next month is the last day of this one.
  const days = new Date(year, month + 1, 0).getDate();

  const cells: (number | null)[] = [];
  for (let i = 0; i < lead; i += 1) cells.push(null);
  for (let d = 1; d <= days; d += 1) cells.push(d);
  return cells;
}

export const WEEKDAY_INITIALS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'] as const;

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;

export function monthName(month: number): string {
  return MONTH_NAMES[month];
}

/** `{ year, month }` shifted by whole months, carrying across the year boundary. */
export function shiftMonth(
  cursor: { year: number; month: number },
  by: number,
): { year: number; month: number } {
  const shifted = new Date(cursor.year, cursor.month + by, 1);
  return { year: shifted.getFullYear(), month: shifted.getMonth() };
}

/**
 * The newest wear for each local day.
 *
 * Newest rather than all of them, because a day cell shows ONE photograph and
 * "the last thing you put on that day" is the honest answer to which one. The
 * count is kept beside it so a day with two outfits can say so rather than
 * silently hiding one.
 *
 * `useWearHistory` already sorts newest-first by `wornAt`, but this does not
 * lean on that: it compares timestamps, so a caller that concatenates pages out
 * of order still gets the right cell.
 */
export interface DayWears {
  /** The one to show. */
  latest: PublicWearEvent;
  /** How many wears that day has in total, including `latest`. */
  count: number;
}

export function indexWearsByDay(events: readonly PublicWearEvent[]): Record<string, DayWears> {
  const byDay: Record<string, DayWears> = {};
  for (const event of events) {
    const key = dayKeyOf(event.wornAt);
    const existing = byDay[key];
    if (existing === undefined) {
      byDay[key] = { latest: event, count: 1 };
    } else {
      byDay[key] = {
        latest:
          Date.parse(event.wornAt) > Date.parse(existing.latest.wornAt)
            ? event
            : existing.latest,
        count: existing.count + 1,
      };
    }
  }
  return byDay;
}

/**
 * The seven local day keys of the week `date` falls in, Monday first.
 *
 * The week the user is IN, not the last seven days. "This week" on a Wednesday
 * means Monday to Sunday with four days still to come — a rolling window would
 * put Thursday of last week beside today and call it the same week, which is
 * not what anybody means by the phrase.
 */
export function weekOf(date: Date): string[] {
  const monday = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  // `getDay()` is 0=Sunday; this app's week starts on Monday.
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  return Array.from({ length: 7 }, (_, i) => {
    const day = new Date(monday);
    day.setDate(monday.getDate() + i);
    return localDayKey(day);
  });
}

const SHORT_MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;

/**
 * `24–30 Aug`, or `28 Sep – 4 Oct` when the week straddles two months.
 *
 * The month is named once when both ends share it. A range that repeats it is
 * not wrong, just noisy, and this sits beside a heading at 12pt.
 */
export function weekRangeLabel(days: readonly string[]): string {
  const first = dateFromDayKey(days[0]);
  const last = dateFromDayKey(days[days.length - 1]);
  if (first === null || last === null) return '';
  const firstMonth = SHORT_MONTHS[first.getMonth()];
  const lastMonth = SHORT_MONTHS[last.getMonth()];
  return firstMonth === lastMonth
    ? `${first.getDate()}\u2013${last.getDate()} ${lastMonth}`
    : `${first.getDate()} ${firstMonth} \u2013 ${last.getDate()} ${lastMonth}`;
}

/** Local midnight on the 1st — the boundary "have we paged back far enough?" asks about. */
export function startOfMonth(year: number, month: number): Date {
  return new Date(year, month, 1);
}

/**
 * Whether the loaded history definitely reaches back past the start of the
 * month being shown.
 *
 * The history endpoint pages newest-first, so a month earlier than the first
 * page needs several `loadMore` calls before its cells can be trusted. False
 * while there is more to fetch AND the oldest event loaded is still inside (or
 * after) the month — which is exactly "we might be missing days of this month".
 */
export function monthIsCovered(
  events: readonly PublicWearEvent[],
  hasMore: boolean,
  year: number,
  month: number,
): boolean {
  if (!hasMore) return true;
  if (events.length === 0) return false;
  const oldest = events.reduce(
    (min, e) => Math.min(min, Date.parse(e.wornAt)),
    Number.POSITIVE_INFINITY,
  );
  return oldest < startOfMonth(year, month).getTime();
}
