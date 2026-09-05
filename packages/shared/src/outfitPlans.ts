/**
 * FR6, forwards: an outfit the user intends to wear on a future day.
 *
 * ## Why this is not a `WearHistory` row with a future date
 *
 * `POST /wear-history` rejects a future `wornAt` outright, deliberately — see
 * `resolveWornAt` in `apps/api/src/routes/wearHistory.ts` — and that rejection
 * is load-bearing rather than incidental. `WearHistory` is the source of truth
 * for `ClothingItem.wearCount` and `lastWornAt`, which is what
 * `GET /analytics/usage` ranks "most/least worn" on. A planned outfit that
 * incremented those counters would make the analytics claim a garment had been
 * worn on a day that has not happened; a planned row that did NOT increment
 * them would need a second "is this real yet" flag threaded through every
 * reader of wear history, and every one of those readers would have to
 * remember to check it.
 *
 * So a plan is its own record. The two facts are independent on purpose: a
 * user can plan an outfit and then wear it (logging a wear normally when the
 * day arrives), wear something else, or let the plan lapse. NOTHING in this
 * system reconciles them, and nothing should without deciding first what a
 * plan the user silently ignored is supposed to mean.
 */
export interface PublicOutfitPlan {
  id: string;
  userId: string;
  outfitId: string;
  /**
   * Absent for the same two reasons `PublicWearEvent.outfitName` is, collapsed
   * on purpose in the same way: the outfit no longer exists, OR it exists and
   * has never had a name. A client must NOT render this absence as "Outfit
   * deleted" — that would be a confident falsehood over an outfit still
   * sitting in the user's gallery.
   */
  outfitName?: string;
  /**
   * The outfit's composition AT THE MOMENT IT WAS PLANNED, snapshotted on
   * write — the same treatment, and the same reasoning, as
   * `PublicWearEvent.itemIds`: the outfit can be edited or deleted afterwards,
   * and a plan must still be able to describe what it was a plan for.
   */
  itemIds: string[];
  /**
   * The day this outfit is planned for.
   *
   * The mirror image of `PublicWearEvent.wornAt`'s rule: a plan for a day
   * already past is rejected on write, because it is not a plan. `wornAt`
   * rejects the future and this rejects the past, and both use a strict
   * comparison against a `now` the server takes after the request lands.
   *
   * CLIENT CONTRACT: send an instant inside the LOCAL day the user picked —
   * local noon is the safe choice, since it survives a daylight-saving shift
   * in either direction where local midnight can land on the adjacent day.
   * `wornAtFor` in `apps/mobile/app/calendar/[date].tsx` already does exactly
   * this for the backwards-looking case.
   */
  plannedFor: string;
  occasion?: string;
  createdAt: string;
}
