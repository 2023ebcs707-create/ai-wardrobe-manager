import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiClientError } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { fetchSavedPosts } from './api';
import { usePostList } from './postInteractions';
import { toDisplayPost, type DisplayPost } from './posts';
import type { CommunityActivity } from './useCommunityFeed';

/**
 * Which operation an error describes. Internal — `error` is exposed as a bare
 * string. Same two sources and same reasoning as `useCommunityFeed`: a scroll
 * must not erase a failed like's message, and a like must not erase a failed
 * page load's.
 */
type ErrorSource = 'list' | 'action';

interface ErrorState {
  source: ErrorSource;
  message: string;
}

export interface UseSavedPostsResult {
  /** The viewer's saved posts, newest **save** first — so a bookmarked
   *  year-old outfit sits at the top, not at the bottom. */
  posts: DisplayPost[];
  activity: CommunityActivity;
  /** A ready-to-render message for the last operation that failed — a list
   *  load or a per-card action — or `null`. */
  error: string | null;
  /** Safe to pass straight to `FlatList#onEndReached`. */
  loadMore: () => void;
  /** Safe to pass straight to `RefreshControl#onRefresh`. */
  refresh: () => void;
  hasMore: boolean;
  /** Like or unlike, optimistically, with the previous state restored on
   *  failure. The same post in the feed updates in the same breath. */
  toggleLike: (postId: string) => Promise<boolean>;
  /**
   * Unsave the post — or save it again, if the user has just unsaved it.
   *
   * **THE POST STAYS IN `posts` UNTIL THE NEXT LOAD, DELIBERATELY**, and that
   * is a statement about this hook's array rather than about what any screen
   * draws. Removing it here would be a removal with no rollback: the patch
   * that restores `saved: true` after a failed unsave can only reach posts the
   * list is still HOLDING, so a row dropped on the optimistic write would stay
   * dropped when the request failed — the exact "an optimistic update that
   * never rolls back lies" failure, arriving through list membership instead
   * of through a flag.
   *
   * **The row does leave the saved list on screen, and that is the screen's
   * job.** `app/(tabs)/favorites.tsx` renders `posts.filter(post => post.saved)`
   * — a list called "Saved posts" showing something the viewer has just
   * unsaved is wrong about its own contents — and filtering at the render is
   * what keeps the row here for the rollback to land on. The two are the same
   * decision seen from two sides, not a disagreement; read that filter's
   * comment before changing either.
   *
   * `markCommunityDirty(['saved'])` — the array form, never the bare call that
   * marks every reader — is raised by the write itself in `usePostList`, so the
   * next time that screen is focused it reloads page one and the post goes for
   * good.
   */
  toggleSave: (postId: string) => Promise<boolean>;
}

function messageFor(err: unknown, fallback: string): string {
  // ApiClientError messages are already written for a person to read.
  if (err instanceof ApiClientError) return err.message;
  return fallback;
}

/**
 * The saved list's data source (TC-12, second half: "post added to user's
 * saved list").
 *
 * **OWNER-SCOPED, AND THIS IS WHERE THIS STAGE'S OWNERSHIP RULE RUNS THE
 * ORDINARY WAY AGAIN.** `useCommunityFeed` twenty files over must never narrow
 * to the caller; this one is narrowed server-side by the token and is private
 * to the viewer. A saved list is what a user kept, not what they published.
 *
 * There is no `remove` here. Deleting a post is an owner-only act on the
 * FEED's copy — you can save your own post, but the affordance belongs on the
 * card in the feed, and two hooks offering the same delete would be two places
 * for the pending-delete guard to be wrong. A delete made in the feed marks
 * this list dirty, which is how the row leaves.
 *
 * There is no search axis either: `GET /community/saved` takes a cursor and
 * nothing else, so a `query` here would be a control with nothing behind it.
 *
 * The races are `useCommunityFeed`'s 1-4, unchanged and for the same reasons —
 * a stale response on both the success and the catch path, overlapping
 * `onEndReached` pages, duplicated refreshes, and an error that keeps the rows
 * it already had. The axis that can go stale is the token rather than a search
 * term, and signing out of A into B and back into A leaves the first A
 * response indistinguishable from the third BY VALUE while being three
 * requests old — which is why the guard is a monotonic sequence number and not
 * a comparison of what was asked for.
 */
export function useSavedPosts(): UseSavedPostsResult {
  const { token } = useAuth();

  const [errorState, setErrorState] = useState<ErrorState | null>(null);

  const clearError = useCallback((source: ErrorSource) => {
    setErrorState((prev) => (prev?.source === source ? null : prev));
  }, []);

  const reportAction = useCallback(
    (message: string | null) => {
      if (message === null) {
        clearError('action');
        return;
      }
      setErrorState({ source: 'action', message });
    },
    [clearError],
  );

  const { posts, setPosts, toggleLike, toggleSave } = usePostList({
    token,
    onError: reportAction,
  });

  const [nextCursor, setNextCursor] = useState<string | undefined>(undefined);
  const [activity, setActivity] = useState<CommunityActivity>('loading');

  // Refs, not state: both are read and written inside one synchronous burst,
  // where a state value would still be the stale one from the last commit.
  const requestIdRef = useRef(0);
  const inFlightRef = useRef<CommunityActivity>('idle');

  const run = useCallback(
    async (kind: Exclude<CommunityActivity, 'idle'>, mode: 'replace' | 'append', cursor?: string) => {
      const requestId = ++requestIdRef.current;
      inFlightRef.current = kind;
      setActivity(kind);
      // A new request makes the previous *load* failure history, not current
      // state.
      clearError('list');

      try {
        const page = await fetchSavedPosts({
          token,
          // Omitted, never sent empty: `?cursor=` is a 400, not "page one".
          ...(cursor === undefined ? {} : { cursor }),
        });

        // Superseded while we were waiting. Dropping the posts is not enough —
        // the cursor has to go too, or the next `loadMore` pages a list
        // belonging to a user who has signed out.
        if (requestIdRef.current !== requestId) return;

        setPosts((prev) =>
          mode === 'append'
            ? [...prev, ...page.posts.map(toDisplayPost)]
            : page.posts.map(toDisplayPost),
        );
        setNextCursor(page.nextCursor);
        setActivity('idle');
      } catch (err) {
        // The same guard on the catch path — a separate mechanism from the one
        // above, and the half that gets forgotten because it is written after
        // the success path already works.
        if (requestIdRef.current !== requestId) return;
        // The posts and the cursor are deliberately untouched.
        setErrorState({
          source: 'list',
          message: messageFor(err, 'Something went wrong loading your saved posts.'),
        });
        setActivity('idle');
      } finally {
        // Only the newest request owns the flag.
        if (requestIdRef.current === requestId) inFlightRef.current = 'idle';
      }
    },
    [token, clearError, setPosts],
  );

  // Mount and token change mean the same thing: the list on screen is not this
  // user's.
  useEffect(() => {
    setPosts([]);
    setNextCursor(undefined);
    void run('loading', 'replace');
  }, [run, setPosts]);

  const loadMore = useCallback(() => {
    if (inFlightRef.current !== 'idle') return;
    // `!= null`, not `!== undefined`: nothing between here and the socket
    // validates the response shape, so a server that ever sent
    // `nextCursor: null` would leave paging permanently "on" and send
    // `?cursor=null` — which the API rejects — on every onEndReached.
    if (nextCursor == null) return;
    void run('loadingMore', 'append', nextCursor);
  }, [run, nextCursor]);

  const refresh = useCallback(() => {
    // Another full-list load is already fetching exactly this. A background
    // `loadingMore` is not, and gets superseded.
    if (inFlightRef.current === 'loading' || inFlightRef.current === 'refreshing') return;
    void run('refreshing', 'replace');
  }, [run]);

  return {
    posts,
    activity,
    error: errorState?.message ?? null,
    loadMore,
    refresh,
    hasMore: nextCursor != null,
    toggleLike,
    toggleSave,
  };
}
