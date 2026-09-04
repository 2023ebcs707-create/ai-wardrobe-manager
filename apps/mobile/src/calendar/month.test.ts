import type { PublicWearEvent } from '@wardrobe/shared';
import {
  dateFromDayKey,
  weekOf,
  weekRangeLabel,
  dayKeyOf,
  indexWearsByDay,
  localDayKey,
  monthCells,
  monthIsCovered,
  shiftMonth,
} from './month';

// `jest.config.js` pins TZ=America/Los_Angeles (UTC-7 in August). That is what
// makes the local-vs-UTC assertions below able to fail: under a UTC pin a
// local-getter implementation and a UTC one are indistinguishable.

function wear(overrides: Partial<PublicWearEvent> & { wornAt: string }): PublicWearEvent {
  return {
    id: overrides.wornAt,
    userId: 'u1',
    outfitId: 'o1',
    itemIds: [],
    createdAt: overrides.wornAt,
    ...overrides,
  };
}

describe('localDayKey', () => {
  it('pads month and day to two digits', () => {
    expect(localDayKey(new Date(2026, 0, 5))).toBe('2026-01-05');
  });
});

describe('dayKeyOf', () => {
  it('files an instant under the LOCAL day, not the UTC one', () => {
    // 01:00 UTC on 2 August is 18:00 on 1 August in Los Angeles. An outfit
    // worn that evening belongs to the 1st on the wearer's calendar.
    expect(dayKeyOf('2026-08-02T01:00:00.000Z')).toBe('2026-08-01');
  });
});

describe('dateFromDayKey', () => {
  it('round-trips through localDayKey', () => {
    expect(localDayKey(dateFromDayKey('2026-08-28')!)).toBe('2026-08-28');
  });

  it('rejects anything that is not YYYY-MM-DD', () => {
    expect(dateFromDayKey('not-a-date')).toBeNull();
  });
});

describe('monthCells', () => {
  it('starts the week on Monday', () => {
    // 1 August 2026 is a Saturday, so Monday-first leaves five leading blanks.
    const cells = monthCells(2026, 7);
    expect(cells.slice(0, 6)).toEqual([null, null, null, null, null, 1]);
    expect(cells[cells.length - 1]).toBe(31);
  });

  it('has no leading blanks when the 1st IS a Monday', () => {
    // 1 June 2026 is a Monday.
    expect(monthCells(2026, 5)[0]).toBe(1);
  });

  it('knows February in a leap year', () => {
    expect(monthCells(2024, 1).filter((d) => d !== null)).toHaveLength(29);
    expect(monthCells(2026, 1).filter((d) => d !== null)).toHaveLength(28);
  });
});

describe('shiftMonth', () => {
  it('carries across the year boundary in both directions', () => {
    expect(shiftMonth({ year: 2026, month: 11 }, 1)).toEqual({ year: 2027, month: 0 });
    expect(shiftMonth({ year: 2026, month: 0 }, -1)).toEqual({ year: 2025, month: 11 });
  });
});

describe('indexWearsByDay', () => {
  it('keeps the newest wear of a day and counts the rest', () => {
    const morning = wear({ wornAt: '2026-08-28T15:00:00.000Z', id: 'morning' });
    const evening = wear({ wornAt: '2026-08-29T02:00:00.000Z', id: 'evening' });
    // Both are 28 August locally (08:00 and 19:00).
    const byDay = indexWearsByDay([morning, evening]);
    expect(Object.keys(byDay)).toEqual(['2026-08-28']);
    expect(byDay['2026-08-28'].latest.id).toBe('evening');
    expect(byDay['2026-08-28'].count).toBe(2);
  });

  it('does not depend on the input being sorted', () => {
    const older = wear({ wornAt: '2026-08-28T15:00:00.000Z', id: 'older' });
    const newer = wear({ wornAt: '2026-08-28T20:00:00.000Z', id: 'newer' });
    expect(indexWearsByDay([newer, older])['2026-08-28'].latest.id).toBe('newer');
    expect(indexWearsByDay([older, newer])['2026-08-28'].latest.id).toBe('newer');
  });
});

describe('weekOf', () => {
  it('starts on the Monday of the week the date falls in', () => {
    // 30 August 2026 is a Sunday, so its week is Monday the 24th to itself.
    expect(weekOf(new Date(2026, 7, 30))).toEqual([
      '2026-08-24', '2026-08-25', '2026-08-26', '2026-08-27',
      '2026-08-28', '2026-08-29', '2026-08-30',
    ]);
  });

  it('returns the week the date is IN, not the last seven days', () => {
    // Wednesday the 26th: the same week as above, with four days still to come.
    expect(weekOf(new Date(2026, 7, 26))[0]).toBe('2026-08-24');
    expect(weekOf(new Date(2026, 7, 26))[6]).toBe('2026-08-30');
  });

  it('crosses a month boundary', () => {
    // 1 October 2026 is a Thursday; its week starts on Monday 28 September.
    expect(weekOf(new Date(2026, 9, 1))[0]).toBe('2026-09-28');
  });
});

describe('weekRangeLabel', () => {
  it('names the month once when both ends share it', () => {
    expect(weekRangeLabel(weekOf(new Date(2026, 7, 30)))).toBe('24\u201330 Aug');
  });

  it('names both when the week straddles two', () => {
    expect(weekRangeLabel(weekOf(new Date(2026, 9, 1)))).toBe('28 Sep \u2013 4 Oct');
  });
});

describe('monthIsCovered', () => {
  const august = [2026, 7] as const;

  it('is covered once the server says there are no more pages', () => {
    expect(monthIsCovered([], false, ...august)).toBe(true);
  });

  it('is not covered while more pages exist and nothing has loaded', () => {
    expect(monthIsCovered([], true, ...august)).toBe(false);
  });

  it('is not covered while the oldest loaded wear is still inside the month', () => {
    expect(monthIsCovered([wear({ wornAt: '2026-08-20T12:00:00.000Z' })], true, ...august)).toBe(
      false,
    );
  });

  it('is covered once a loaded wear predates the month', () => {
    expect(monthIsCovered([wear({ wornAt: '2026-07-30T12:00:00.000Z' })], true, ...august)).toBe(
      true,
    );
  });
});
