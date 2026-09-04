/**
 * The small display formatters more than one screen needs.
 *
 * Both of these started life inside a route module — `formatDay` as
 * `formatAddedOn` in `app/items/[id].tsx`, `countLabel` in
 * `app/outfits/[id].tsx` — and both were correct there. Stage 6 Task 5 needs
 * them on a third screen (a wear-history row shows a date and an item count),
 * and the choice was between a third copy and one module.
 *
 * A third copy would have been the cheaper diff and the worse code: `formatDay`
 * is only correct because of an argument about timezones that is written down
 * once, below, and a copy that quietly used the UTC getters would render a
 * different date on the same screen as this one and look like a data problem.
 *
 * `missingLabel` in `app/outfits/[id].tsx` is deliberately NOT hoisted with
 * them: it is one screen's sentence about one screen's situation, and moving
 * it would be motion rather than reuse.
 */
import type { ItemCategory } from '@wardrobe/shared';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * `2026-08-01T10:00:00.000Z` → `1 Aug 2026`, **in the device's own timezone**.
 *
 * Two separate decisions here, and an earlier revision of this function ran
 * them together and got the second one wrong.
 *
 * *Assembled by hand rather than through `toLocaleDateString`*, because Hermes
 * on Android ships a cut-down `Intl` and the option bag a locale format needs
 * is not reliably honoured on the one platform this app targets.
 *
 * *Read with the local-time getters, not the UTC ones.* `getDate()` and its
 * siblings are local-time and involve no `Intl` at all, so the Hermes argument
 * above says nothing about them — it was never a reason to use UTC. And UTC is
 * actively wrong here: an item added at 18:00 on 1 August in Los Angeles is
 * stored as `2026-08-02T01:00:00.000Z`, so a field labelled "Added" would read
 * "2 Aug 2026" — a date in the future. That is not an edge case near the date
 * line; it is every negative UTC offset, every evening.
 *
 * The same argument applies with more force to a wear-history row, where the
 * date IS the record: TC-08 reads "entry recorded with date". A wear logged at
 * 8pm reading back as tomorrow is the kind of wrongness a user notices and
 * cannot explain.
 *
 * Testable because `jest.config.js` pins `process.env.TZ` to a deliberately
 * non-UTC zone, which is what makes the two readings distinguishable in a test
 * at all.
 */
export function formatDay(iso: string): string {
  const at = new Date(iso);
  // A malformed timestamp must not render the literal string "Invalid Date".
  if (Number.isNaN(at.getTime())) return iso;
  return `${at.getDate()} ${MONTHS[at.getMonth()]} ${at.getFullYear()}`;
}

/**
 * `3 items`, `1 item`, `0 items`.
 *
 * Zero takes the plural, which is why the test is `count === 1` and not
 * `count > 1`. An outfit with no items cannot be saved, so no screen before
 * this one could produce a zero — but a wear event carries its own snapshotted
 * `itemIds`, and a client must survive rendering whatever the server sends.
 */
export function countLabel(count: number): string {
  return `${count} ${count === 1 ? 'item' : 'items'}`;
}

/**
 * `3 wears`, `1 wear`, `0 wears`.
 *
 * Separate from `countLabel` rather than a `unit` parameter on it: a shared
 * pluraliser parameterised by noun is one edit away from being asked for an
 * irregular plural, and two three-line functions are cheaper than that
 * conversation. The leaderboard is exactly where "1 wears" gets shipped, which
 * is why this exists at all instead of a template literal at each call site.
 */
export function wearLabel(count: number): string {
  return `${count} ${count === 1 ? 'wear' : 'wears'}`;
}

/**
 * `tshirt` → `T-shirt`. The category as a person writes it.
 *
 * `ItemCategory` values are lowercase identifiers chosen for the wire, and
 * they read as identifiers on screen — "tshirt" is not a word. Only the ones
 * that are not simply their own capitalisation are listed; everything else
 * falls through to a capital first letter, so adding a category to
 * `ITEM_CATEGORIES` cannot leave this function throwing or blank.
 *
 * Display only. Nothing here may be sent back to the API — `GET
 * /items?category=T-shirt` is a 400.
 */
const CATEGORY_LABELS: Partial<Record<ItemCategory, string>> = {
  tshirt: 'T-shirt',
};

export function categoryLabel(category: ItemCategory): string {
  return CATEGORY_LABELS[category] ?? category[0].toUpperCase() + category.slice(1);
}
