/**
 * "The planned outfits on the server are not the ones the calendar is holding"
 * — one bit per reader, shared between the screens that write plans and the
 * screens that read them.
 *
 * ## Why a third signal rather than folding into `trackingDirty`
 *
 * `trackingDirty` carries "wear counts or laundry statuses moved". A plan
 * moves neither: it touches no `ClothingItem` at all, by design (see
 * `PublicOutfitPlan` in `@wardrobe/shared`). Marking the tracking bit for a
 * plan would make the wardrobe grid and the Profile tab throw away their
 * scrolled pages to reload lists that did not change — the exact regression
 * `trackingDirty`'s own header records as the reason it names a subset of
 * readers.
 *
 * ## Which existing module this copies
 *
 * `trackingDirty`, per the instruction written at its head: it is the general
 * form, `outfitsDirty` is the special case that works only because the outfit
 * gallery is its single reader. So this is a per-reader set, not a global
 * boolean, even though `'calendar'` is the only reader today — a second one
 * (a "what's coming up" panel on Profile, say) must not be able to consume the
 * calendar's bit.
 *
 * ## Lifetime
 *
 * Module scope: one set per JS bundle instance, which is one per app launch.
 * Not persisted, and it must not be — a flag surviving a restart would mean a
 * refetch the fresh mount is doing anyway.
 */

export const PLAN_READERS = ['calendar'] as const;

export type PlanReader = (typeof PLAN_READERS)[number];

const dirty = new Set<PlanReader>();

/**
 * Record that the set of planned outfits has changed underneath whoever is
 * holding it.
 *
 * Idempotent per reader: marking twice before a consume is the same as marking
 * once, because a reader's response to any number of changes is one reload.
 */
export function markPlansDirty(readers: readonly PlanReader[] = PLAN_READERS): void {
  readers.forEach((reader) => dirty.add(reader));
}

/**
 * Read one reader's bit and clear it. `Set.delete` answers whether the member
 * was there, which is exactly read-and-clear in one call.
 *
 * Consuming rather than merely reading is what stops one change causing a
 * refetch on every subsequent focus for the rest of the session.
 */
export function consumePlansDirty(reader: PlanReader): boolean {
  return dirty.delete(reader);
}
