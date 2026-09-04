import type { PublicClothingItem } from './items';

/**
 * The bound `POST /wear-history` applies to `occasion`, shared rather than
 * restated in each layer for the same reason `MAX_OUTFIT_NAME_LENGTH` is: a
 * client that enforces a different bound than the API either lets a user type
 * their way into a 400 or refuses input the API would have accepted.
 *
 * Applied AFTER trimming: 64 characters of padding is a 60-character occasion.
 */
export const MAX_OCCASION_LENGTH = 60;

/**
 * One logged wear of one outfit — FR6, TC-08.
 *
 * A wear event is an immutable historical fact. Nothing in this system edits
 * one, which is why the shape carries no `updatedAt`.
 */
export interface PublicWearEvent {
  id: string;
  userId: string;
  outfitId: string;
  /**
   * Absent for **two** different reasons, and a reader cannot tell them apart.
   *
   * 1. The outfit no longer exists (ruling 3 — deleting an outfit does not
   *    un-happen a wear, so the event outlives it).
   * 2. The outfit exists and has never had a name. `PublicOutfit.name` is
   *    optional, `OutfitComposer`'s field is labelled "Outfit name, optional",
   *    and the composer omits the key entirely when it is blank — so this is
   *    an ordinary state that the app produces routinely, not an edge case.
   *
   * `GET /wear-history` collapses them ON PURPOSE (`outfitNames()` in
   * `apps/api/src/routes/wearHistory.ts`: "An outfit with no name and an
   * outfit that no longer exists both mean 'no name to show'"), and its
   * integration suite asserts both cases adjacently. The name is resolved from
   * the live `Outfit` document at READ time, which is also why a rename — not
   * only a delete — changes what a past event reads back as.
   *
   * **So a client must NOT render this absence as "Outfit deleted".** That
   * would be a confident falsehood shown above an outfit still sitting in the
   * user's gallery. `apps/mobile/src/tracking/WearHistoryRow.tsx` renders
   * "Deleted or unnamed outfit", which names the deletion without asserting it
   * as the only cause.
   *
   * An earlier version of this comment said only "Absent when the outfit has
   * since been deleted", which is half the behaviour — and it is where the
   * "Outfit deleted" wording came from in the first place. See the itemIds
   * note for what the event uses to describe itself when this is absent.
   */
  outfitName?: string;
  /**
   * The outfit's composition AT THE MOMENT IT WAS WORN, snapshotted on write.
   *
   * Not read through the outfit at display time, for two reasons: the outfit
   * can be edited afterwards and a wear record must say what was actually
   * worn, and an outfit can be deleted outright, which would otherwise leave
   * the event unable to describe itself.
   */
  itemIds: string[];
  /**
   * When the outfit was worn, which is NOT when the row was written.
   *
   * Back-dating is ordinary use — a user logs yesterday's outfit this morning
   * — so this is the key the history list sorts on. A future `wornAt` is
   * rejected on write: a wear that has not happened yet is not a wear, and it
   * would take permanent possession of "most recently worn".
   *
   * CLIENT CONTRACT — this is a request rule, not just a response note:
   *
   * **Logging a wear that is happening NOW: OMIT `wornAt` and let the server
   * date it. Send `wornAt` ONLY for a date the user explicitly chose in the
   * past.**
   *
   * The future check is exact and has no skew tolerance. A client that sends
   * its own `new Date().toISOString()` for "now" is betting that its clock is
   * not ahead of the server's by even a few milliseconds, and a handset with
   * an unsynced clock loses that bet with a 400 the user cannot act on. The
   * tolerance a client actually gets is one-way transit time and nothing more,
   * so this is invisible on a dev machine — where the device and the API share
   * one clock and skew is zero — and appears only in the field. A window would
   * not fix it either: any number large enough to absorb a real handset's skew
   * is large enough to admit a genuinely future date.
   *
   * Omitting the field removes the bet entirely: the server stamps the instant
   * the request landed, which is what "now" means anyway.
   */
  wornAt: string;
  occasion?: string;
  createdAt: string;
}

/**
 * Page size bounds for `GET /analytics/usage`.
 *
 * Deliberately NOT the list endpoints' `DEFAULT_LIMIT`/`MAX_LIMIT` (24/100).
 * Analytics is a top-N question, not a page of a list: "most worn" with 24
 * entries on a 30-item wardrobe is the wardrobe in a different order, and the
 * Profile screen renders a short leaderboard, not an infinite scroll. The
 * ceiling exists because the endpoint signs a URL per returned item, so a
 * caller-chosen N is a caller-chosen amount of work.
 *
 * Shared rather than restated in the client for the same reason
 * `MAX_OCCASION_LENGTH` is: a client that assumes a different cap either
 * requests its way into a 400 or renders fewer rows than it could have.
 */
export const DEFAULT_ANALYTICS_LIMIT = 5;
export const MAX_ANALYTICS_LIMIT = 50;

/**
 * The usage analytics Phase 3 promises: "View usage analytics showing
 * most/least worn items".
 *
 * Ranked on `ClothingItem.wearCount` -- the counter `POST /wear-history`
 * maintains -- and NOT by aggregating the wear log. The log's purpose is
 * history and provenance; a per-item counter answers "most worn" in one
 * indexed query, and computing it twice in two places is how the two answers
 * start to disagree.
 *
 * `mostWorn` and `leastWorn` can OVERLAP, and that is correct rather than a
 * bug to hide: a wardrobe with three items has all three in both lists. The
 * alternative -- subtracting one list from the other -- would make "least
 * worn" mean "least worn, excluding some items that are worn even less",
 * which is a different and wrong question.
 *
 * `leastWorn` includes never-worn items (`wearCount: 0`). Those are exactly
 * the items a wardrobe app exists to surface; excluding them would make the
 * feature say nothing at all on a fresh wardrobe.
 */
export interface PublicUsageAnalytics {
  mostWorn: PublicClothingItem[];
  leastWorn: PublicClothingItem[];
  /** Sum of `wearCount` across the caller's items -- every wear of every item. */
  totalWears: number;
  /** How many of the caller's items are currently `in_laundry`. */
  itemsInLaundry: number;
}
