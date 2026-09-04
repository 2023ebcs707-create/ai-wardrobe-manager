/**
 * A one-bit "the outfit list on the server is not the one the gallery is
 * holding" signal, shared between the screens that write outfits and the
 * gallery that reads them.
 *
 * ## Why this exists at module scope rather than in a context or a store
 *
 * There is no cross-screen outfit store in this app, and `useOutfits` keys its
 * effect on `[token]` alone, so the gallery cannot see its own staleness.
 * Task 5's first answer was to refetch on every focus, which was correct about
 * freshness and wrong about everything else: `refresh()` is a page-ONE load, so
 * coming back from a detail screen threw away every page the user had scrolled
 * to. Browse, open one, come back, keep browsing — the gallery's primary loop —
 * was broken for anyone with more than one page of outfits.
 *
 * The fix is to refetch when something actually changed, and *what changed* is
 * known precisely at the three places that change it: a rename, a delete, and a
 * create. A module-level flag is the smallest thing that carries one bit from
 * those places to the gallery without widening `useOutfits`'s briefed return
 * shape and without threading a provider through a router that owns the tree.
 *
 * ## Why a flag and not a queue of ids
 *
 * The gallery's only response to any of these events is "reload page one", so
 * every distinguishable payload would collapse to the same action. A set of
 * changed ids would let a future gallery patch single rows in place — but it
 * would also be state that can disagree with the server, which is the class of
 * bug `useOutfits` spent a whole review round removing. One bit cannot go
 * stale in a way that matters: the worst case is one unnecessary page-one
 * fetch.
 *
 * ## Lifetime
 *
 * Module scope means one flag per JS bundle instance, which is one per app
 * launch — the same lifetime as the navigator that owns the gallery. It is not
 * persisted and must not be: a flag surviving a restart would mean a refetch
 * the fresh mount is doing anyway.
 *
 * Jest gives every test FILE its own module registry, so this cannot leak
 * between suites. It CAN leak between tests in one file, which is why the
 * suites that touch it consume it in `beforeEach` — deliberately through the
 * public function rather than through a test-only reset, so the tests exercise
 * the same door the app uses.
 */

let dirty = false;

/**
 * Record that the outfit list has changed underneath whoever is holding it.
 *
 * Idempotent: marking twice before a consume is the same as marking once,
 * because the reader's response to any number of changes is one reload.
 */
export function markOutfitsDirty(): void {
  dirty = true;
}

/**
 * Read the flag and clear it, atomically as far as any JS caller can tell.
 *
 * Consuming rather than merely reading is what stops one change causing a
 * refetch on every subsequent focus for the rest of the session. It also means
 * exactly one reader may act on a given change — which is correct here,
 * because there is exactly one gallery.
 */
export function consumeOutfitsDirty(): boolean {
  const wasDirty = dirty;
  dirty = false;
  return wasDirty;
}
