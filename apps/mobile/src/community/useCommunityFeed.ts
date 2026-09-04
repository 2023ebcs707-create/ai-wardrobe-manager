import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiClientError } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { deletePost, fetchFeed } from './api';
import { markCommunityDirty } from './communityDirty';
import { usePostList } from './postInteractions';
import { toDisplayPost, type DisplayPost } from './posts';

/**
 * What is in flight *right now*. Deliberately orthogonal to `error`, which
 * says what happened *last*.
 *
 * Stage 4's `WardrobeActivity` contract carried forward unchanged, and shared
 * with `useSavedPosts` so a screen rendering both keys on one type. An earlier
 * draft of that hook folded the two axes into one `status` union
 * (`loading | ready | error | refreshing`) and it conflated them: after a
 * page-2 failure, calling `loadMore()` again really does issue the request,
 * but a combined status stays on `error` until that request settles — so a
 * retry button has no way to show that the retry started.
 *
 * - `idle`        — nothing in flight. Says nothing about success; read
 *                   `error` for that.
 * - `loading`     — a full-list load with nothing renderable behind it: first
 *                   mount, a token change, or a new search term (all three
 *                   clear the rows).
 * - `refreshing`  — pull-to-refresh; the previous rows are still on screen.
 * - `loadingMore` — a page append; the rows already loaded stay valid.
 *
 * A like, a save and a delete are deliberately NOT values here: none of them
 * is a list load, and a feed must not spin its whole grid because one heart
 * was tapped.
 *
 * `loadingMore` IS here, unlike `SuggestionsActivity` which drops it — the
 * feed is a real paged list with a cursor, so paging is a control with
 * something behind it.
 */
export type CommunityActivity = 'idle' | 'loading' | 'refreshing' | 'loadingMore';

/**
 * Which operation an error describes. Internal — `error` is exposed as a bare
 * string, because a screen renders a message and not a taxonomy.
 *
 * The same mechanism `useOutfits`' `ErrorSource` introduced, and for the same
 * measured reason: list loads and per-card actions are independent operations
 * sharing one channel, and "clear the error when a new request starts" is only
 * correct *within* an operation. Without the tag an `onEndReached` fired by an
 * idle scroll silently wipes a failed like's message, and a successful like
 * wipes a genuine "couldn't load page 2" while the list is still short. Both
 * statements were still true when they were erased.
 *
 * Two sources rather than three: a like, a save and a delete are all per-card
 * actions with the same lifetime — the user tapped a control on a row and it
 * did not work — so they legitimately replace each other's message. A list
 * load's failure outlives all of them, because the page it failed to fetch is
 * still missing.
 */
type ErrorSource = 'list' | 'action';

interface ErrorState {
  source: ErrorSource;
  message: string;
}

/**
 * How long the feed waits after the last keystroke before searching.
 *
 * **A REQUEST PER KEYSTROKE IS NOT MERELY WASTEFUL HERE, IT IS WASTEFUL IN THE
 * WRONG DIRECTION.** `?q=` costs O(feed size) rather than O(result size):
 * measured at 5000 posts, a *rare* term scans 5000 index keys to return
 * nothing while a common term scans 59 to return 20. So the expensive query is
 * the one that finds nothing — which is exactly what every prefix of a word
 * is, and exactly what an undebounced search box sends one of per letter.
 * Typing "waistcoat" unthrottled is nine scans of the whole feed to render one
 * result.
 *
 * Exported so a test names the same number the hook does rather than a copy of
 * it that can drift.
 */
export const SEARCH_DEBOUNCE_MS = 300;

export interface UseCommunityFeedResult {
  /** Posts from ALL users, newest first, with every interaction made anywhere
   *  in the app already applied. */
  posts: DisplayPost[];
  activity: CommunityActivity;
  /**
   * A ready-to-render message for the last operation that failed — a list load
   * or a per-card action — or `null`. A failure is only cleared by an
   * operation of the same kind, so a scroll cannot erase a failed like's
   * message and a like cannot erase a failed page load's.
   */
  error: string | null;
  /** Safe to pass straight to `FlatList#onEndReached`; see the guard below. */
  loadMore: () => void;
  /** Safe to pass straight to `RefreshControl#onRefresh`. */
  refresh: () => void;
  hasMore: boolean;
  /**
   * What the user has typed, unmodified, for a controlled `TextInput`. NOT
   * what is currently being searched for — the request trails it by
   * `SEARCH_DEBOUNCE_MS`.
   */
  query: string;
  /**
   * Update the search box. Cheap to call on every keystroke: the text updates
   * immediately and the request is debounced inside this hook, where it cannot
   * be forgotten by a screen.
   *
   * Whatever is typed is sent as typed, apart from a trim — see
   * `FetchFeedOptions.q` for why nothing is stripped on the way out. Leading
   * and trailing spaces do not start a new search, so "blue " and "blue" are
   * one request rather than two.
   */
  setQuery: (next: string) => void;
  /**
   * Like the post if the viewer has not, unlike it if they have — optimistically,
   * with the previous state restored on failure. By id; see `PostListState`.
   */
  toggleLike: (postId: string) => Promise<boolean>;
  /** Save or unsave the post, on the same optimistic terms. */
  toggleSave: (postId: string) => Promise<boolean>;
  /**
   * Delete one of the viewer's OWN posts, dropping it from the feed only once
   * the server has confirmed.
   *
   * Resolves `true` when the post is gone and `false` when it is not — in
   * which case the row is untouched and `error` carries the message. A 404
   * resolves `true`: the post is already gone server-side, which is what the
   * caller asked for. Collapsing that to `false` would leave a row that can
   * never be deleted, because the one answer meaning "it is not there" would
   * be treated as "it is still there".
   *
   * It resolves rather than rejects, so a screen writing
   * `onPress={() => remove(post.id)}` cannot produce an unhandled rejection.
   */
  remove: (postId: string) => Promise<boolean>;
}

function messageFor(err: unknown, fallback: string): string {
  // ApiClientError messages are already written for a person to read (the
  // client turns a network failure into "Cannot reach the server…" and passes
  // the API's own message through otherwise).
  if (err instanceof ApiClientError) return err.message;
  return fallback;
}

/** A 404 from `DELETE /community/posts/:id` means the post is not there —
 *  deleted from another device, or never the caller's to begin with (a foreign
 *  post answers 404, not 403, deliberately). Either way it is gone. */
function isAlreadyGone(err: unknown): boolean {
  return err instanceof ApiClientError && err.status === 404;
}

/**
 * Drop anything deleted this session from a list the server just sent.
 *
 * The server computes a page *before* a concurrent delete commits, so a
 * response already in flight can carry a row the user has removed — and a
 * pagination shift can re-serve one on a later page. Neither is a stale
 * *response* (the request-sequence guard is about ordering and would let both
 * through, correctly), so the filter has to be here, on every list write.
 *
 * Left unfiltered the row simply comes back and stays. Tapping delete on it
 * then answers 404 and, but for `isAlreadyGone`, would paint "Post not found"
 * over a delete that in fact succeeded.
 */
function withoutDeleted(list: DisplayPost[], deleted: Set<string>): DisplayPost[] {
  return list.filter((post) => !deleted.has(post.id));
}

/**
 * The community feed's data source (FR10 / TC-12).
 *
 * **THIS HOOK READS POSTS FROM EVERY USER, INCLUDING USERS THE VIEWER HAS
 * NEVER MET.** Nothing here narrows the list to the signed-in user and nothing
 * may: the token decides who `liked` and `saved` are about, not whose posts
 * come back. Every other list hook in this app is owner-scoped, so the shape
 * of a mistake here is a one-line filter that looks exactly like the code in
 * `useWardrobe` and `useOutfits` and turns a community feed into an audience
 * of one.
 *
 * The races handled here rather than in the screen, because none of them is
 * visible until the network is slow:
 *
 * 1. **Stale responses.** Typing "blue", then "red", then "blue" again issues
 *    three requests and the first can answer last. Every request carries a
 *    monotonic sequence number and only the newest may write state. A *value*
 *    comparison — "is this response for the term I currently hold?" — is not
 *    enough: it says yes to the first "blue" response, which is three requests
 *    old and describes the feed as it was before "red" ever loaded. The
 *    responses carry no term at all, so nothing but ordering separates them.
 *    The guard covers the catch path as well as the success path — two
 *    mechanisms, two tests, because the catch half is the one written after
 *    the success path already works.
 * 2. **Overlapping pages.** `onEndReached` fires many times through one fling.
 *    `loadMore` is a no-op while anything at all is in flight.
 * 3. **Duplicated refreshes.** Double-tapping "Try again" on a slow network
 *    would otherwise issue two identical page-one requests. `refresh` is a
 *    no-op while another full-list load is running — but it deliberately
 *    still *supersedes* a background page append, because a pull-to-refresh is
 *    an explicit gesture and silently dropping it is worse than one extra
 *    round trip.
 * 4. **Partial state on failure.** An error keeps the posts and the cursor, so
 *    the user keeps what they had and `onEndReached` can retry.
 * 5. **A request per keystroke.** See `SEARCH_DEBOUNCE_MS`; the debounce lives
 *    here rather than in the screen so that no screen can omit it.
 * 6. **Double-tapped deletes.** `DELETE /community/posts/:id` is not
 *    idempotent-silent, so a second delete of the same id answers 404.
 * 7. **A response that predates a delete.** See `withoutDeleted`.
 *
 * Likes and saves carry their own races, and they are handled one layer down
 * in `usePostList` because the saved list needs exactly the same ones.
 *
 * The screen is only reachable when authenticated (`app/_layout.tsx` redirects
 * anonymous users and renders a splash while restoring), so the token is
 * present by the time this mounts; no guard for a null token is needed and a
 * 401 would surface through `error` anyway.
 */
export function useCommunityFeed(): UseCommunityFeedResult {
  const { token } = useAuth();

  const [errorState, setErrorState] = useState<ErrorState | null>(null);

  // Only an operation of the same kind may clear an error. Stable across
  // renders: `run` depends on it, and the mount effect depends on `run`, so an
  // unstable identity here would re-fetch on every render.
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

  const [query, setQuery] = useState('');
  // What is actually being searched for: `query` after the debounce and a
  // trim. Separate state rather than a ref, because the fetch effect keys on
  // it and a ref would not re-run it.
  const [term, setTerm] = useState('');
  const [nextCursor, setNextCursor] = useState<string | undefined>(undefined);
  const [activity, setActivity] = useState<CommunityActivity>('loading');

  // Refs, not state: both are read and written inside one synchronous burst
  // (`onEndReached` firing three times before React can re-render), where a
  // state value would still be the stale one from the last commit. That is
  // exactly the case the guards exist for, so they cannot be built on state.
  const requestIdRef = useRef(0);
  const inFlightRef = useRef<CommunityActivity>('idle');

  // Keyed by post id, not a single flag: two different rows may be deleted at
  // once, and only a repeat of the *same* id is the duplicate this guards. The
  // stored promise is handed back to the second caller so both observe the
  // same outcome rather than the second being told the delete failed.
  const pendingDeletesRef = useRef(new Map<string, Promise<boolean>>());

  // Everything deleted this session. Bounded by deletes the user actually
  // performs — a few per session, not a cache — and read on every list write.
  const deletedIdsRef = useRef(new Set<string>());

  const run = useCallback(
    async (
      kind: Exclude<CommunityActivity, 'idle'>,
      mode: 'replace' | 'append',
      forTerm: string,
      cursor?: string,
    ) => {
      const requestId = ++requestIdRef.current;
      inFlightRef.current = kind;
      setActivity(kind);
      // A new request makes the previous *load* failure history, not current
      // state. Without this a banner keyed on `error !== null` sits under the
      // refresh spinner still showing the message the refresh is trying to
      // clear.
      clearError('list');

      try {
        const page = await fetchFeed({
          token,
          // Omitted, never sent empty: `?cursor=` is a 400, not "page one".
          ...(cursor === undefined ? {} : { cursor }),
          // Omitted when blank, which is what "no filter" means here.
          ...(forTerm === '' ? {} : { q: forTerm }),
        });

        // Superseded while we were waiting. Dropping the posts is not enough —
        // the cursor has to go too, or the next `loadMore` pages the search
        // the user has already moved off.
        if (requestIdRef.current !== requestId) return;

        setPosts((prev) =>
          // Filtered on BOTH paths: a refresh can restore a deleted row and an
          // append can re-serve one after a pagination shift.
          withoutDeleted(
            mode === 'append'
              ? [...prev, ...page.posts.map(toDisplayPost)]
              : page.posts.map(toDisplayPost),
            deletedIdsRef.current,
          ),
        );
        setNextCursor(page.nextCursor);
        setActivity('idle');
      } catch (err) {
        // The same guard on the catch path, which is the half that gets
        // forgotten because it is written after the success path already
        // works. Without it a search the user has moved on from paints an
        // error over a feed that loaded fine.
        if (requestIdRef.current !== requestId) return;
        // The posts and the cursor are deliberately untouched.
        setErrorState({
          source: 'list',
          message: messageFor(err, 'Something went wrong loading the community feed.'),
        });
        setActivity('idle');
      } finally {
        // Only the newest request owns the flag; a superseded one clearing it
        // would re-open `loadMore` while its replacement is still running.
        if (requestIdRef.current === requestId) inFlightRef.current = 'idle';
      }
    },
    [token, clearError, setPosts],
  );

  // Debounce. Nothing is scheduled when the trimmed text already matches what
  // is being searched for, so holding down backspace over trailing spaces does
  // not keep re-arming a timer for a search that would not change.
  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed === term) return;
    const timer = setTimeout(() => setTerm(trimmed), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, term]);

  // Mount, search-term change and token change all mean the same thing: the
  // list on screen no longer matches what was asked for. Clearing here rather
  // than inside `setQuery` keeps the three entry points on one code path.
  useEffect(() => {
    setPosts([]);
    setNextCursor(undefined);
    void run('loading', 'replace', term);
  }, [run, term, setPosts]);

  const loadMore = useCallback(() => {
    if (inFlightRef.current !== 'idle') return;
    // `!= null`, not `!== undefined`: nothing between here and the socket
    // validates the response shape (`apiRequest` ends in `return parsed as T`),
    // so a server that ever sent `nextCursor: null` would leave paging
    // permanently "on" and send `?cursor=null` — which the API rejects — on
    // every onEndReached. The declared type says that cannot happen; this
    // costs one character and does not rely on the declaration being true.
    if (nextCursor == null) return;
    void run('loadingMore', 'append', term, nextCursor);
  }, [run, term, nextCursor]);

  const refresh = useCallback(() => {
    // Another full-list load is already fetching exactly this; a second one is
    // pure duplicate work. A background `loadingMore` is not, and gets
    // superseded — see race 3 above.
    if (inFlightRef.current === 'loading' || inFlightRef.current === 'refreshing') return;
    // Page one of the *current* search, replacing the list on success. The
    // rows stay on screen meanwhile — a refresh is not a reset.
    void run('refreshing', 'replace', term);
  }, [run, term]);

  // Record the deletion first, then drop the row. The record is what keeps a
  // response that predates the delete from putting it back; the filter here is
  // what takes it off the screen now.
  const forget = useCallback(
    (postId: string) => {
      deletedIdsRef.current.add(postId);
      setPosts((prev) => prev.filter((post) => post.id !== postId));
    },
    [setPosts],
  );

  const remove = useCallback(
    (postId: string): Promise<boolean> => {
      const pending = pendingDeletesRef.current.get(postId);
      if (pending) return pending;

      const attempt = (async () => {
        // A previous *action* failure is history once a new one starts. A load
        // failure is not: the page it failed to fetch is still missing.
        clearError('action');
        try {
          await deletePost(postId, token);
          // Only now. Dropping the row first would make a failed delete look
          // like a success until the next refresh silently brought the post
          // back, with nothing to explain it.
          //
          // Deliberately NOT guarded by the request sequence: the delete is a
          // fact about the server, not a view of it. Bumping the sequence here
          // would be worse than useless — it would discard an in-flight page
          // load *and* latch `inFlightRef`, closing `loadMore` for the rest of
          // the session.
          forget(postId);
          // The server cascades the post's saves away, so anyone's saved list
          // — including this viewer's own — is now holding a row that no
          // longer exists. The feed took care of itself above.
          markCommunityDirty(['saved']);
          return true;
        } catch (err) {
          // Already gone is the outcome the caller wanted, not a failure.
          if (isAlreadyGone(err)) {
            forget(postId);
            markCommunityDirty(['saved']);
            return true;
          }
          setErrorState({
            source: 'action',
            message: messageFor(err, 'Something went wrong deleting that post.'),
          });
          return false;
        } finally {
          // Per in-flight request, not per id forever: a delete that failed
          // has to be retryable. This runs after an `await`, so it can never
          // beat the `set` below to the map.
          pendingDeletesRef.current.delete(postId);
        }
      })();

      pendingDeletesRef.current.set(postId, attempt);
      return attempt;
    },
    [token, clearError, forget],
  );

  return {
    posts,
    activity,
    error: errorState?.message ?? null,
    loadMore,
    refresh,
    hasMore: nextCursor != null,
    query,
    setQuery,
    toggleLike,
    toggleSave,
    remove,
  };
}
