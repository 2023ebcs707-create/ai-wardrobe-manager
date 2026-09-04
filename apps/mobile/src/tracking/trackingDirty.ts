/**
 * "The tracking data on the server is not the data these screens are holding"
 * — one bit **per reader**, shared between the screens that write wear and
 * laundry and the screens that read them.
 *
 * ## Why this is not `outfitsDirty`
 *
 * Stage 5's `src/outfits/outfitsDirty.ts` is the pattern this follows, and
 * reusing it outright was the first thing tried. It does not work, and its own
 * header says why in as many words: `consumeOutfitsDirty` reads AND clears, so
 * "exactly one reader may act on a given change — which is correct here,
 * because there is exactly one gallery."
 *
 * Tracking has two readers and they are on different tabs. A laundry toggle
 * changes what the wardrobe grid must draw (FR7/TC-09's badge) *and* what the
 * Profile tab's `itemsInLaundry` says; logging a wear changes every member
 * item's `wearCount`, which is the exact field the analytics rank on. With one
 * shared bit, whichever tab the user opened first would consume it and the
 * other would be told nothing had happened — a stale screen that no amount of
 * navigating fixes, because the change has already been spent.
 *
 * Folding tracking into the *outfits* bit would be worse again: every laundry
 * toggle would throw away the outfit gallery's scrolled pages to reload a list
 * that had not changed.
 *
 * So: a second signal, with the state kept per reader. `markTrackingDirty`
 * sets every reader's bit; each reader consumes its own.
 *
 * ## WHICH OF THE TWO A THIRD SIGNAL SHOULD COPY
 *
 * **This one.** Two modules with different APIs now exist, and that is a fork
 * a later change can pick the wrong side of, so the answer is written down
 * rather than left to whichever file gets opened first: `outfitsDirty` is the
 * SPECIAL CASE — a single bit, correct only because the outfit gallery is the
 * one and only reader of it — and this module is the general form. A third
 * signal should add a reader to a per-reader set, not a second global boolean.
 * `outfitsDirty` is left alone rather than migrated because rewriting a
 * mechanism three Stage 5 screens depend on was not this task's job; if it is
 * ever touched, it should collapse into this shape.
 *
 * ## Why a closed union of readers rather than an open string key
 *
 * A typo'd reader id would be a screen that silently never refreshes, and that
 * is precisely the failure this module exists to prevent. The union makes
 * adding a reader a deliberate, compile-checked act; `TRACKING_READERS` is the
 * one place the set is written down, and it is exported so a test can walk it
 * instead of restating it.
 *
 * ## Why bits and not a queue of ids
 *
 * Every reader's only response to any of these events is "reload page one", so
 * every distinguishable payload would collapse to the same action. A set of
 * changed ids would be state that can disagree with the server; one bit cannot
 * go stale in a way that matters, and its worst case is one unnecessary
 * page-one fetch.
 *
 * ## Lifetime
 *
 * Module scope: one set per JS bundle instance, which is one per app launch —
 * the same lifetime as the navigator that owns the tabs. Not persisted, and it
 * must not be: a flag surviving a restart would mean a refetch the fresh mount
 * is doing anyway.
 *
 * Jest gives every test FILE its own module registry, so this cannot leak
 * between suites. It CAN leak between tests in one file, which is why the
 * suites that touch it drain it in `beforeEach`/`afterEach` — deliberately
 * through the public function rather than a test-only reset, so the tests use
 * the same door the app does.
 */

/**
 * Every screen that reads tracking data, cannot see its own staleness, **and
 * is gated on this signal**.
 *
 * ## A third reader exists and is deliberately not here: the outfit composer
 *
 * `OutfitComposer` calls `useWardrobe()` with no focus gate, and the Add tab
 * stays mounted once visited. So: open Add, switch to outfit mode, go to the
 * Wardrobe tab, put a garment in the wash, come back to Add — and that garment
 * renders in the composer with no treatment on it.
 *
 * Not gated, and the reason is that its staleness is neither new nor specific
 * to laundry. That composer instance has been showing a stale wardrobe since
 * Stage 5 for every attribute it renders: an item uploaded on the Add tab's
 * other mode, or a category corrected on the detail screen, is equally
 * invisible to it. Gating only the laundry half of a general problem would
 * make the composer *look* current while still being wrong about everything
 * else, and it would put a `useFocusEffect` inside a `src/` component — which
 * owns the `useWardrobe` instance, so the Add tab above it cannot do the
 * refresh on its behalf.
 *
 * Recorded here rather than discovered later because the union is closed on
 * purpose: adding a reader is meant to be a deliberate, compile-checked act,
 * and a reader that was never considered is exactly what a closed union is for
 * catching. Whoever gives the Add tab a focus policy should add `'composer'`
 * here in the same change.
 *
 * ## `'calendar'`
 *
 * The month grid reads `GET /wear-history` and cannot see its own staleness
 * for exactly the reason the wardrobe grid cannot: logging a wear happens on a
 * screen pushed OVER this tab (`app/calendar/[date].tsx`, or the outfit detail
 * screen), which stays mounted underneath, and `useWearHistory`'s fetch effect
 * keys on the token alone. Without this the day the user just logged stays
 * blank on the calendar they logged it from.
 */
export const TRACKING_READERS = ['wardrobe', 'profile', 'calendar'] as const;

export type TrackingReader = (typeof TRACKING_READERS)[number];

const dirty = new Set<TrackingReader>();

/**
 * Record that wear counts or laundry statuses have changed underneath whoever
 * is holding them.
 *
 * Marks EVERY reader by default, because every write this stage makes moves
 * data both of them show: a laundry transition changes the grid's badge and
 * Profile's `itemsInLaundry`; a wear changes `wearCount`, which the grid does
 * not draw today but which Profile's leaderboard is ranked on, and
 * `lastWornAt`, which the item detail screen renders.
 *
 * ## Why a subset can be named
 *
 * **Two** writes in this stage are genuinely one-sided, and both are about the
 * outfit's NAME rather than about any item. `GET /wear-history` resolves
 * `outfitName` from the live `Outfit` document at READ time
 * (`apps/api/src/routes/wearHistory.ts`, `outfitNames()`), so:
 *
 * - **Deleting an outfit** makes every history row pointing at it read back
 *   nameless. This was Task 4's hand-off note rather than something invented
 *   here.
 * - **Renaming an outfit** makes every history row pointing at it read back
 *   under the new name. Identical mechanism, and it was missed on the first
 *   pass precisely because the delete is the dramatic one: the rows survive
 *   either way, and the rename leaves the Profile tab confidently displaying a
 *   name the user changed a moment ago, for the rest of the session.
 *
 * Neither touches any item — no `wearCount`, no `lastWornAt`, no
 * `laundryStatus` — so marking the wardrobe grid for either would make the
 * grid throw away every page the user had scrolled to, in order to reload a
 * list that did not move. That is the exact regression the focus gates exist
 * to prevent, arriving through the signal instead of through the effect.
 *
 * The default stays "all readers" because that is the safe direction: a caller
 * who forgets to think about it causes at most one unnecessary page-one fetch,
 * whereas a default of "none" would be a screen that silently never refreshes.
 *
 * An EMPTY array marks nothing, deliberately. The obvious "no readers means
 * all readers" defaulting would turn a caller that computed an empty set into
 * a whole-app refetch, which is the opposite of what it asked for.
 *
 * Idempotent per reader: marking twice before a consume is the same as marking
 * once, because a reader's response to any number of changes is one reload.
 */
export function markTrackingDirty(readers: readonly TrackingReader[] = TRACKING_READERS): void {
  readers.forEach((reader) => dirty.add(reader));
}

/**
 * Read one reader's bit and clear it, atomically as far as any JS caller can
 * tell. `Set.delete` answers whether the member was there, which is exactly
 * read-and-clear in one call.
 *
 * Consuming rather than merely reading is what stops one change causing a
 * refetch on every subsequent focus for the rest of the session.
 */
export function consumeTrackingDirty(reader: TrackingReader): boolean {
  return dirty.delete(reader);
}
