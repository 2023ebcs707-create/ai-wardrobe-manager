import { ITEM_CATEGORIES } from '@wardrobe/shared';
import { categoryLabel, countLabel, formatDay, wearLabel } from './text';

/**
 * These two started life inside `app/items/[id].tsx` and `app/outfits/[id].tsx`
 * respectively. Stage 6 Task 5 needed both on a third screen — a wear-history
 * row shows a date and an item count — and a third copy of a function whose
 * correctness turns on a timezone argument is how the three drift apart.
 *
 * The timezone half is only testable because `jest.config.js` pins
 * `process.env.TZ` to `America/Los_Angeles`, deliberately NOT UTC: under a UTC
 * pin a UTC-getter implementation and a local-getter one are indistinguishable
 * and the test that is supposed to tell them apart passes against both.
 */
describe('formatDay', () => {
  it('renders a date the way the item detail screen always has', () => {
    expect(formatDay('2026-08-01T10:00:00.000Z')).toBe('1 Aug 2026');
  });

  it('reads the timestamp in the DEVICE timezone, not UTC', () => {
    // An item added at 18:00 on 1 August in Los Angeles is stored as
    // 2026-08-02T01:00:00.000Z. Formatted with the UTC getters, a field
    // labelled "Added" would read "2 Aug 2026" — a date in the future. That is
    // not an edge case near the date line; it is every negative UTC offset,
    // every evening.
    expect(formatDay('2026-08-02T01:00:00.000Z')).toBe('1 Aug 2026');
  });

  it('covers every month name', () => {
    // The month table is indexed by `getMonth()`, so an off-by-one or a
    // missing entry shows up as the wrong word or `undefined` — and only for
    // part of the year, which a single January fixture would never see.
    const months = [
      'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
      'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
    ];
    months.forEach((name, index) => {
      // Midday UTC keeps every one of these on the same local day under the
      // pinned -07:00/-08:00 offset, so this asserts the month table and
      // nothing else.
      const iso = `2026-${String(index + 1).padStart(2, '0')}-15T12:00:00.000Z`;
      expect(formatDay(iso)).toBe(`15 ${name} 2026`);
    });
  });

  it('never renders the literal string "Invalid Date"', () => {
    // `new Date('not a date')` is a valid Date object whose getters all answer
    // NaN, so the template would produce "NaN undefined NaN" and `String(at)`
    // would produce "Invalid Date". Echoing the raw value back is ugly but
    // true, and it is the one form that lets a person report what they saw.
    expect(formatDay('not a date')).toBe('not a date');
  });
});

describe('countLabel', () => {
  it('agrees with the noun', () => {
    expect(countLabel(1)).toBe('1 item');
    expect(countLabel(3)).toBe('3 items');
  });

  it('says "0 items" rather than "0 item"', () => {
    // English pluralises zero. A `count > 1` test would get this wrong and no
    // fixture in the outfit screen would have caught it: an outfit with no
    // items cannot be saved, but a wear event whose snapshot is empty is a
    // shape the client must survive rendering.
    expect(countLabel(0)).toBe('0 items');
  });
});

describe('wearLabel', () => {
  it('agrees with the noun', () => {
    // The leaderboard is exactly where "1 wears" gets shipped: every fixture a
    // developer writes by hand has a comfortable number in it.
    expect(wearLabel(1)).toBe('1 wear');
    expect(wearLabel(9)).toBe('9 wears');
  });

  it('says "0 wears" rather than "0 wear"', () => {
    // `leastWorn` includes never-worn items on purpose — they are exactly what
    // a wardrobe app exists to surface — so zero is the COMMON value in that
    // list rather than an edge case.
    expect(wearLabel(0)).toBe('0 wears');
  });
});

describe('categoryLabel', () => {
  it('writes the wire identifier as a word', () => {
    expect(categoryLabel('tshirt')).toBe('T-shirt');
  });

  it('capitalises anything with no special spelling', () => {
    expect(categoryLabel('jacket')).toBe('Jacket');
    expect(categoryLabel('accessory')).toBe('Accessory');
  });

  it('has a label for every category the API accepts', () => {
    // Walks the shared list rather than restating it: a category added there
    // must not reach a screen as a blank or as a lowercase identifier.
    for (const category of ITEM_CATEGORIES) {
      const label = categoryLabel(category);
      expect(label.length).toBeGreaterThan(0);
      expect(label[0]).toBe(label[0].toUpperCase());
    }
  });
});
