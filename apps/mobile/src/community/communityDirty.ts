/**
 * "The community data on the server is not the data these screens are holding"
 * — one bit **per reader**, shared between the places that write posts and
 * saves and the two lists that read them.
 *
 * ## Why this is a third signal rather than one of the two that exist
 *
 * `src/tracking/trackingDirty.ts` states the rule this module follows: it is
 * the general form, `outfitsDirty` is the special case (a single global bit,
 * correct only because the outfit gallery is its one and only reader), and a
 * third signal should add readers to a per-reader set rather than add a second
 * global boolean. So the SHAPE is copied from `trackingDirty`, deliberately,
 * down to the closed reader union and the read-and-clear consume.
 *
 * What is not copied is the reader set, and it could not be. `TRACKING_READERS`
 * is `['wardrobe', 'profile']`, and `markTrackingDirty` marks every reader by
 * default because every write in that stage moves data both of those screens
 * draw. Adding `'feed'` and `'saved'` to that union would fuse two unrelated
 * data sets: a laundry toggle would throw away the community feed's scrolled
 * pages to reload a list that did not move, and a save would do the same to
 * the wardrobe grid. That is the exact regression the focus gates exist to
 * prevent, arriving through the signal instead of through the effect.
 *
 * Reusing `outfitsDirty` would be worse again — it is one bit with one
 * consumer, so whichever of the Search and Favorites tabs was opened first
 * would consume a change and the other would be told nothing had happened, and
 * a share would additionally blank the outfit gallery.
 *
 * ## Who marks, and who does not
 *
 * `usePostList` (in `postInteractions.ts`) marks `'saved'` itself when a save
 * or an unsave settles, because that write happens inside this data layer and
 * a mark left to a screen is a mark that can be forgotten. It marks NOTHING
 * for a like: likes are broadcast live to every mounted list by the
 * interaction channel, so there is no staleness left for a flag to describe,
 * and marking would cost a page-one reload per like.
 *
 * `useCommunityFeed`'s `remove` marks `'saved'` and ONLY `'saved'`. The feed
 * takes its own row off the screen, so it has no staleness to record, while
 * the server cascades the post's saves away underneath every saved list. The
 * default — `markCommunityDirty()` with no argument — would be wrong here in a
 * way that is invisible until a user scrolls: it would additionally mark
 * `'feed'`, and the next focus would throw away every page the user had
 * scrolled to in order to reload page one of a list that is already correct.
 * That is the regression the reader split above exists to prevent, and it is
 * one omitted argument away.
 *
 * Sharing marks `'feed'` inside `ShareOutfitSheet`, on the line after a
 * successful `sharePost` and BEFORE the host's `onShared` runs.
 *
 * That is a deliberate departure from the `app/(tabs)/add.tsx` convention,
 * which leaves the marking to the host by passing `markOutfitsDirty` as the
 * composer's `onSaved`. Three reasons, and the second is the load-bearing one:
 * `sharePost` has exactly one caller in the app, so there is no second call
 * site for the mark to drift away from; the host's callback is also its cue to
 * dismiss the sheet and navigate, so a mark placed after it is a mark on a
 * component that is already going away; and a mark left to a screen is a mark
 * that can be forgotten, which is the same reason `usePostList` marks `'saved'`
 * itself rather than asking its callers to.
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
 * Every screen that reads community data, cannot see its own staleness, **and
 * is gated on this signal**.
 *
 * - `'feed'` — the Search tab's community feed. Stale after a share, and after
 *   a delete made from anywhere other than the list holding the post.
 * - `'saved'` — the Favorites tab's saved list. Stale after any save or
 *   unsave, because a save adds a ROW the list is not holding and no live
 *   patch can conjure one; and after a delete, because a deleted post's saves
 *   cascade away underneath it.
 *
 * Closed on purpose: a typo'd reader id would be a screen that silently never
 * refreshes, which is precisely the failure this module exists to prevent.
 * Adding a reader is a deliberate, compile-checked act, and this array is the
 * one place the set is written down — exported so a test can walk it instead
 * of restating it.
 */
export const COMMUNITY_READERS = ['feed', 'saved'] as const;

export type CommunityReader = (typeof COMMUNITY_READERS)[number];

const dirty = new Set<CommunityReader>();

/**
 * Record that community data has changed underneath whoever is holding it.
 *
 * Marks EVERY reader by default. The default stays "all readers" because that
 * is the safe direction: a caller who forgets to think about it causes at most
 * one unnecessary page-one fetch, whereas a default of "none" would be a
 * screen that silently never refreshes.
 *
 * An EMPTY array marks nothing, deliberately. The obvious "no readers means
 * all readers" defaulting would turn a caller that computed an empty set into
 * a whole-app refetch, which is the opposite of what it asked for.
 *
 * Idempotent per reader: marking twice before a consume is the same as marking
 * once, because a reader's response to any number of changes is one reload.
 */
export function markCommunityDirty(readers: readonly CommunityReader[] = COMMUNITY_READERS): void {
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
export function consumeCommunityDirty(reader: CommunityReader): boolean {
  return dirty.delete(reader);
}
