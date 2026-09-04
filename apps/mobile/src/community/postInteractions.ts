import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { ApiClientError } from '../api/client';
import { likePost, savePost, unlikePost, unsavePost } from './api';
import { markCommunityDirty } from './communityDirty';
import type { DisplayPost } from './posts';

/**
 * A change to the three viewer-relative fields of ONE post.
 *
 * **EVERY FIELD IS AN ABSOLUTE VALUE, NEVER A DELTA, AND THAT IS THE WHOLE
 * DESIGN.** A patch says "this post's like count is 6", not "add one". Three
 * things follow, and only the first is obvious:
 *
 * 1. Applying the same patch twice is applying it once. A double tap that
 *    somehow got past the in-flight guard could not inflate a local count,
 *    which is the failure the server's own idempotency deliberately does not
 *    cover: the unique `{ postId, userId }` index stops the SERVER's count
 *    moving twice and can say nothing about a client that incremented twice.
 * 2. Two lists holding the same post cannot drift apart by applying the same
 *    patch, however many times each of them sees it.
 * 3. **"Roll the failure back by decrementing whatever the count has since
 *    become" is not expressible here.** A rollback can only name a number, and
 *    the only number it has is the one it snapshotted before it touched
 *    anything. That is the property `toggleLike` needs and it is enforced by
 *    the channel rather than remembered by the caller.
 *
 * Absent fields are left alone rather than set to a default, which is what
 * lets a like and a save be in flight on one post at once without either
 * clobbering the other's flag.
 */
export interface PostInteractionPatch {
  postId: string;
  liked?: boolean;
  likeCount?: number;
  saved?: boolean;
}

/**
 * Apply one patch to a list, or hand back the very same array when the post is
 * not in it.
 *
 * The identity check is not a micro-optimisation. Every mounted list receives
 * every patch, so the feed sees each of the saved list's patches and vice
 * versa; returning a fresh array each time would re-render both lists on every
 * interaction anywhere in the app, including for posts they do not hold.
 */
export function applyPostPatch(
  posts: DisplayPost[],
  patch: PostInteractionPatch,
): DisplayPost[] {
  let matched = false;
  const next = posts.map((post) => {
    if (post.id !== patch.postId) return post;
    matched = true;
    // Spread field by field rather than `...patch`: the patch carries a
    // `postId` that must not become a field on the post.
    return {
      ...post,
      ...(patch.liked === undefined ? {} : { liked: patch.liked }),
      ...(patch.likeCount === undefined ? {} : { likeCount: patch.likeCount }),
      ...(patch.saved === undefined ? {} : { saved: patch.saved }),
    };
  });
  return matched ? next : posts;
}

type PostInteractionListener = (patch: PostInteractionPatch) => void;

/**
 * Every mounted list, so a like made in one lands in all of them.
 *
 * ## Why a module-level channel rather than each hook fixing up its own copy
 *
 * The feed and the saved list are different screens on different tabs and they
 * routinely hold the SAME post: a user saves something from the feed, and it is
 * now in both. Two hooks each mutating their own copy is two copies that
 * disagree the moment either of them is touched — you like a post on the
 * Search tab, open Favorites, and the heart is hollow with a count one lower.
 * A note telling the next task to keep them in step is not a control; one
 * channel that every mutation goes through is.
 *
 * ## Why list LOADS are deliberately not published here
 *
 * Only mutations broadcast. A page of posts that arrives from `GET
 * /community/posts` is written into the list that asked for it and nowhere
 * else, because a feed page is computed server-side at some moment and may
 * already be older than a like another list has since made — republishing it
 * would let a stale read overwrite a fresher truth, which is exactly the
 * corruption the snapshot rollback below exists to avoid. The cost is that two
 * lists loaded at different times can hold different like COUNTS for one post
 * until either is touched, and the next interaction reconciles them.
 *
 * ## Lifetime
 *
 * Module scope, one set per JS bundle instance. Listeners add themselves on
 * mount and remove themselves on unmount, so an unmounted list cannot be
 * written to. Jest gives every test FILE its own module registry, so the set
 * cannot leak between suites; within a file it is emptied by RNTL's own
 * cleanup, which unmounts every hook after each test.
 *
 * NO TEST IN THIS REPOSITORY COVERS THE UNSUBSCRIBE, and the honest place to
 * say so is here rather than only in a report. React has not warned on a state
 * update after unmount since v18, so a listener left behind is silent through
 * this hook's own surface — every patch it applies goes to a `setPosts` nobody
 * renders. Task 4's mutation harness records the removal of
 * `listeners.delete(listener)` below as SURVIVED for exactly that reason. What
 * a leak costs is one listener per mounted-and-discarded list for the life of
 * the bundle instance; what would make it testable is a read-only count on
 * this module, which is a door into the channel that nothing else needs.
 */
const listeners = new Set<PostInteractionListener>();

function publish(patch: PostInteractionPatch): void {
  // Iterated over a copy: a listener that unmounts (and so unsubscribes) while
  // this is running must not change the set underneath the loop.
  //
  // NO TEST COVERS THE COPY, and Task 4's harness records dropping it —
  // `listeners.forEach(...)` — as SURVIVED. Reaching the difference needs a
  // listener that unsubscribes SYNCHRONOUSLY from inside this loop, and the
  // only thing a listener does here is call `setPosts`, which React never
  // turns into a synchronous unmount. It is kept as the cheap half of a trade:
  // one array copy per interaction, against a failure that would be silent
  // (a list skipped by a patch) if this loop ever did run while the set moved.
  [...listeners].forEach((listener) => listener(patch));
}

function messageFor(err: unknown, fallback: string): string {
  // ApiClientError messages are already written for a person to read (the
  // client turns a network failure into "Cannot reach the server…" and passes
  // the API's own message through otherwise).
  if (err instanceof ApiClientError) return err.message;
  return fallback;
}

export interface PostListOptions {
  token: string | null;
  /**
   * Called with `null` when an interaction starts and with a ready-to-render
   * message when one fails.
   *
   * Cleared when the write STARTS rather than when it succeeds: a screen
   * rendering its banner on `error !== null` would otherwise show the dead
   * message for the whole round trip of the retry that is meant to clear it.
   *
   * Must be stable across renders — the toggles depend on it.
   */
  onError: (message: string | null) => void;
}

export interface PostListState {
  /** The rows, with every interaction made anywhere in the app already
   *  applied. */
  posts: DisplayPost[];
  /** For the owning hook's own list loads. Not exposed past this layer. */
  setPosts: Dispatch<SetStateAction<DisplayPost[]>>;
  /**
   * Like the post if the viewer has not, unlike it if they have.
   *
   * **BY ID, NOT BY POST**, and that is a control rather than a convenience:
   * the snapshot a rollback restores has to be the state as this list holds it
   * *now*, and a caller handing over a post object decides that snapshot for
   * itself. A card captured in a closure one render ago would roll a failure
   * back to a count that was true two taps earlier. Looking the post up here
   * makes a stale snapshot unreachable from outside.
   *
   * Resolves `true` when the server confirmed and `false` otherwise — and it
   * resolves rather than rejects, deliberately, so a screen writing
   * `onPress={() => toggleLike(post.id)}` cannot produce an unhandled
   * rejection.
   *
   * An id this list is not holding is a no-op that resolves `false` and issues
   * no request: there is no snapshot to roll back to, so there is nothing this
   * function could honestly do.
   */
  toggleLike: (postId: string) => Promise<boolean>;
  /** Save the post if the viewer has not, unsave it if they have. Same
   *  contract as `toggleLike` in every respect. */
  toggleSave: (postId: string) => Promise<boolean>;
}

/**
 * The rows a community list holds, and the two things a viewer can do to one.
 *
 * Shared by `useCommunityFeed` and `useSavedPosts` rather than written twice:
 * the optimistic write, the rollback and the guard are the race-critical part
 * of this stage, and two near-copies of race-critical code drift.
 *
 * ## Optimistic, with a rollback that restores rather than undoes
 *
 * A like that waits for the server feels broken — the round trip is visible on
 * a phone — so the heart flips and the count moves immediately. A like that
 * never rolls back lies, so a failure puts back exactly the values that were
 * there before the tap.
 *
 * The rollback names the SNAPSHOT and never a delta, and the difference is
 * observable rather than stylistic. Take the case the API's own comment
 * measured: a like that did not insert answers `likeCount: 0` with
 * `liked: true`, so a card can genuinely hold `{ liked: true, likeCount: 0 }`.
 * Unlike it, the count clamps at 0 rather than going negative, the request
 * fails, and an "undo the delta" rollback adds one back — inventing a like on
 * a post that has none, out of a failed unlike. Restoring the snapshot puts
 * back 0, which is what was there.
 *
 * ## The guard, and what it deliberately does not cover
 *
 * Keyed by post AND kind, so a like and a save can be in flight on one post at
 * once while a second tap of the same control gets the first tap's promise
 * back. A ref rather than state, for the reason `useGuardedMutation` gives:
 * React commits a state flag on the NEXT render, which is strictly after every
 * handler queued in the current frame has run, so a `pending` state flag is
 * read as `false` by the second tap and guards nothing.
 *
 * Per hook instance rather than module-wide, which is the weaker of the two
 * and is chosen on purpose. Module-wide, a user who likes a post on the Search
 * tab and then taps the same card on the Favorites tab before the first
 * request lands would have their second tap silently swallowed and be handed
 * the first tap's result — a toggle that ignores you.
 *
 * What per-instance costs is worth writing down exactly, because the obvious
 * account of it — "both taps go out and the server's second answer wins" — is
 * not what happens. MEASURED, both hooks mounted on one post:
 *
 * 1. The second tap is an **unlike**, not a second like. The first tap's
 *    optimistic patch has already reached the second list through the channel,
 *    so the second hook looks the post up and finds `liked: true`. Two
 *    requests go out, one `POST` and one `DELETE` — which is what two taps of
 *    a toggle mean, and neither of them is swallowed.
 * 2. The answer that sticks is the **last to arrive**, not the second to be
 *    issued. Both are published absolutely, so whichever settles last is the
 *    state both lists keep.
 *
 * The divergence is therefore a reordered pair of replies rather than a
 * doubled like: settle the `DELETE` first and the `POST` second and both lists
 * end at `{ liked: true, likeCount: 4 }` while the server holds
 * `{ liked: false, likeCount: 3 }`, until anything reloads. That is the price,
 * and it is still the better side of the trade — it needs two fingers on two
 * tabs and a reordering, whereas module-wide swallows an ordinary second tap
 * on one card, which is the case the guard is actually for.
 */
export function usePostList({ token, onError }: PostListOptions): PostListState {
  const [posts, setPosts] = useState<DisplayPost[]>([]);

  // The list as last COMMITTED, read by the toggles. A ref rather than the
  // state value closed over by `useCallback`, so a toggle created on one
  // render cannot snapshot a post as it was on an earlier one.
  const postsRef = useRef<DisplayPost[]>(posts);
  useEffect(() => {
    postsRef.current = posts;
  }, [posts]);

  // Keyed `${kind}:${postId}`; see the header for why a ref and why per
  // instance.
  const inFlightRef = useRef(new Map<string, Promise<boolean>>());

  useEffect(() => {
    const listener: PostInteractionListener = (patch) => {
      setPosts((prev) => applyPostPatch(prev, patch));
    };
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  const runGuarded = useCallback(
    (key: string, perform: () => Promise<boolean>): Promise<boolean> => {
      const existing = inFlightRef.current.get(key);
      if (existing) return existing;

      const attempt = (async (): Promise<boolean> => {
        try {
          // `perform()` is invoked here, synchronously, before the first
          // suspension point — so the optimistic patch is published and the
          // request issued before `runGuarded` returns, and the map entry
          // below is set on a call that has really started.
          return await perform();
        } finally {
          // Per in-flight call, not per key forever: a like that failed has to
          // be retryable. This runs after an `await`, so it can never beat the
          // `set` below to the map.
          inFlightRef.current.delete(key);
        }
      })();

      inFlightRef.current.set(key, attempt);
      return attempt;
    },
    [],
  );

  const toggleLike = useCallback(
    (postId: string): Promise<boolean> => {
      const post = postsRef.current.find((candidate) => candidate.id === postId);
      if (!post) return Promise.resolve(false);

      return runGuarded(`like:${postId}`, async () => {
        // THE SNAPSHOT. Everything below names these two values and never the
        // list's current ones, so nothing that happens while the request is in
        // flight can turn the rollback into a different number.
        const wasLiked = post.liked;
        const wasCount = post.likeCount;

        onError(null);
        // Optimistic, and absolute: `wasCount + 1` rather than "increment",
        // so this cannot compound.
        //
        // Clamped at zero on the unlike side. The server's gate is the real
        // floor — it decrements only when a like row was actually removed —
        // but this client can hold a count of 0 with `liked: true` (a like
        // that did not insert answers exactly that), and a card that reads
        // "-1 likes" for even one frame is worse than one that reads 0.
        publish({
          postId,
          liked: !wasLiked,
          likeCount: wasLiked ? Math.max(0, wasCount - 1) : wasCount + 1,
        });

        try {
          const result = wasLiked
            ? await unlikePost(postId, token)
            : await likePost(postId, token);
          // The server's latest word, applied absolutely — it accounts for
          // every other user's likes since this list was loaded, which the
          // optimistic guess above cannot.
          publish({ postId, liked: result.liked, likeCount: result.likeCount });
          return true;
        } catch (err) {
          // RESTORE, never undo. See the header for the failed unlike at zero,
          // where the two differ and only this one is right.
          publish({ postId, liked: wasLiked, likeCount: wasCount });
          onError(messageFor(err, 'Something went wrong updating that like.'));
          return false;
        }
      });
    },
    [runGuarded, token, onError],
  );

  const toggleSave = useCallback(
    (postId: string): Promise<boolean> => {
      const post = postsRef.current.find((candidate) => candidate.id === postId);
      if (!post) return Promise.resolve(false);

      return runGuarded(`save:${postId}`, async () => {
        const wasSaved = post.saved;

        onError(null);
        publish({ postId, saved: !wasSaved });

        try {
          const result = wasSaved
            ? await unsavePost(postId, token)
            : await savePost(postId, token);
          publish({ postId, saved: result.saved });
          // A save adds a ROW to the saved list, and an unsave removes one.
          // No patch can conjure a row a list is not holding, so this is the
          // one interaction that leaves a screen genuinely stale — marked here
          // rather than at a call site, because a mark left to a screen is a
          // mark that can be forgotten. Deliberately NOT marked for a like:
          // the patch above already put that in every mounted list, and
          // marking would buy a page-one reload per like.
          markCommunityDirty(['saved']);
          return true;
        } catch (err) {
          publish({ postId, saved: wasSaved });
          onError(messageFor(err, 'Something went wrong updating your saved posts.'));
          return false;
        }
      });
    },
    [runGuarded, token, onError],
  );

  return { posts, setPosts, toggleLike, toggleSave };
}
