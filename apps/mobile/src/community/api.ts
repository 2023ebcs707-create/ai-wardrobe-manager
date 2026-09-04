import type { PublicPost } from '@wardrobe/shared';
import { apiRequest } from '../api/client';
import { toDisplayPost, type DisplayPost } from './posts';

/**
 * One page of the community feed, or of the viewer's saved list.
 *
 * The two endpoints answer the same envelope on purpose — `GET
 * /community/posts` and `GET /community/saved` both resolve their rows through
 * one server-side helper so that a post cannot describe itself differently
 * depending on which list it arrived in — so one page type serves both and one
 * paging implementation reads both.
 *
 * ## Why the rows here are the RAW `PublicPost`, unlike `sharePost`'s answer
 *
 * A page is paging machinery. `nextCursor` belongs to the envelope and the
 * rows are whatever the route sent, so this type states what the wire said and
 * nothing more. The conversion to `DisplayPost` — which is where `itemIds`
 * stops — happens at exactly one line in each hook (`page.posts.map(
 * toDisplayPost)` inside `useCommunityFeed`'s `run` and `useSavedPosts`'
 * `run`), and those two lines are the only readers of this field in the app.
 *
 * **So this is the one place in this layer where both arrays are still within
 * reach, and its presence is a consequence of describing a wire page rather
 * than an invitation to render from one.** `items` is compacted and
 * de-duplicated while `itemIds` is neither, so `items[i]` is not in general
 * `itemIds[i]` and one unresolved garment puts every later pairing off by one.
 * A screen therefore does not call `fetchFeed`/`fetchSavedPosts` and render
 * their rows; it takes `useCommunityFeed`/`useSavedPosts`, whose posts are
 * `DisplayPost` and carry no `itemIds` at all. `sharePost` below converts
 * inside this module for exactly that reason: it answers ONE post, so there is
 * no paging left to describe and no reason for a raw row to leave here.
 */
export interface PostsPage {
  posts: PublicPost[];
  /**
   * Absent — not null — once the last page has been served. Both routes spread
   * the key in conditionally, so "no more pages" is `nextCursor === undefined`
   * and nothing else.
   */
  nextCursor?: string;
}

export interface FetchFeedOptions {
  token: string | null;
  /** Opaque, server-issued. Never parsed or constructed here. */
  cursor?: string;
  /**
   * A caption search. Omitted entirely when absent or blank — see
   * `buildFeedQuery`.
   *
   * **Sent as the user typed it, apart from a trim.** No character is stripped
   * on the way out. `GET /community/posts` answers 400 for a term that still
   * contains a C0 control character or DEL after its own trim, and a single
   * line of typed text cannot produce one — so a term that reaches that 400 is
   * a client that built a term rather than took one, and it should be visible
   * rather than laundered into a request that looks fine.
   */
  q?: string;
}

export interface FetchSavedPostsOptions {
  token: string | null;
  /** Opaque, server-issued. Never parsed or constructed here. */
  cursor?: string;
}

/**
 * What both like endpoints answer with.
 *
 * `likeCount` IS THE SERVER'S LATEST WORD RATHER THAN A PROMISE, and the route
 * says so: the request that actually inserts reads its number back from the
 * increment, but a request that did not insert answers with the count as it
 * stood when the handler read the post — measured, eight simultaneous likes of
 * one post leave the stored count at exactly 1 while seven of the replies can
 * each say 0. The stored count is what is exact.
 *
 * `liked` is a different kind of thing: a fact about the VIEWER'S OWN like
 * row, which only this viewer's own requests move. Both routes answer it from
 * the operation they just performed — `POST` answers `true` whether or not it
 * inserted, `DELETE` answers `false` whether or not it removed — so against
 * this server it always agrees with the button that was tapped.
 *
 * **A client applies BOTH fields of this answer absolutely and second-guesses
 * neither**, which is what `usePostList` does at the one line where a settled
 * result is published. For `liked` the answer and the optimistic guess agree
 * by construction, so preferring the guess would buy nothing and would put a
 * branch on the settle path that trusts one half of a reply and discards the
 * other; for `likeCount` the answer is strictly newer than the guess, because
 * it accounts for every other user's likes since the page was loaded.
 */
export interface PostLikeResult {
  likeCount: number;
  liked: boolean;
}

export interface PostSaveResult {
  saved: boolean;
}

export interface SharePostOptions {
  token: string | null;
  /** An outfit the CALLER owns. A foreign outfit, one that never existed and a
   *  malformed id all answer the same 404 — deliberately, so this endpoint
   *  cannot be used as an existence oracle over other users' outfits. */
  outfitId: string;
  /** Trimmed and at most `MAX_CAPTION_LENGTH` characters, enforced again by
   *  the API. Whitespace-only is a 400, not an empty caption. */
  caption: string;
}

/**
 * Builds the `GET /community/posts` query string.
 *
 * Every parameter is *omitted* when it is absent rather than sent empty, the
 * same discipline `GET /items` needs: `?cursor=` fails to decode and answers
 * 400. `?q=` is the one exception on this route — an empty term means "no
 * filter" there rather than an error — and it is still omitted, because a
 * parameter that changes nothing is noise in a URL and in a test's assertion.
 *
 * **There is no `limit`, on purpose, and adding one is not a free
 * optimisation.** At `limit=100` a single feed request issues up to 100
 * concurrent item lookups server-side, which is the MongoDB driver's default
 * pool size — so "fewer round trips" is bought with a request that can occupy
 * the entire pool. The server's own default is 24 and this client takes it.
 *
 * `URLSearchParams` also does the percent-encoding, which matters for both
 * fields here: the cursor is opaque (the server issues base64url today and
 * nothing may rely on that), and `q` is free text a user can type a space, an
 * ampersand or a `+` into.
 */
function buildFeedQuery(opts: FetchFeedOptions): string {
  const params = new URLSearchParams();
  if (opts.cursor !== undefined) params.set('cursor', opts.cursor);
  // Blank is not a search for the empty string, and `?q=` would say the same
  // thing to the server at the cost of a parameter that means nothing.
  if (opts.q !== undefined && opts.q.trim() !== '') params.set('q', opts.q.trim());

  const query = params.toString();
  return query ? `?${query}` : '';
}

/** Builds the `GET /community/saved` query string. Cursor only — the saved
 *  list has no search axis, and the `limit` argument above applies here too. */
function buildSavedQuery(opts: FetchSavedPostsOptions): string {
  const params = new URLSearchParams();
  if (opts.cursor !== undefined) params.set('cursor', opts.cursor);

  const query = params.toString();
  return query ? `?${query}` : '';
}

/**
 * FR10 / TC-12: one page of the public community feed.
 *
 * **POSTS FROM ALL USERS, INCLUDING THE CALLER'S OWN.** The token
 * authenticates the reader and decides the viewer-relative `liked` and `saved`
 * flags; it does not narrow whose posts come back. There is no owner filter to
 * pass and there must never be one — a "community" feed scoped to its reader
 * has an audience of one.
 */
export async function fetchFeed(opts: FetchFeedOptions): Promise<PostsPage> {
  return apiRequest<PostsPage>(`/community/posts${buildFeedQuery(opts)}`, { token: opts.token });
}

/**
 * The viewer's own saved posts, newest **save** first.
 *
 * Owner-scoped, and this is the half of the stage where ownership runs the
 * ordinary way again: a saved list is what a user kept, not what they
 * published. The ordering is by the save, not by the post, so a bookmarked
 * year-old outfit sits at the top.
 */
export async function fetchSavedPosts(opts: FetchSavedPostsOptions): Promise<PostsPage> {
  return apiRequest<PostsPage>(`/community/saved${buildSavedQuery(opts)}`, { token: opts.token });
}

/**
 * FR9 / TC-11: share an outfit you own to the feed, with a caption.
 *
 * Answers the shared post **in the shape a card renders** — a `DisplayPost`,
 * the very type `useCommunityFeed`'s rows are — so the card that was just
 * shared can be rendered without refetching. Unwrapped from the API's
 * `{ post }` envelope here, the way `fetchItem` unwraps `{ item }`, and then
 * put through `toDisplayPost`.
 *
 * **The conversion is the point rather than a convenience.** The wire post
 * carries `itemIds` beside `items` and the two are not parallel; handing it
 * straight back would let a confirmation card pair `items[i]` with
 * `itemIds[i]`, which is off by one from the first garment that no longer
 * resolves onwards — the wrong garment under the wrong id, silently. The
 * firewall `DisplayPost` puts in front of the two list hooks has to hold on
 * this path too, and a warning in this comment would not be that firewall:
 * only not handing over the other array is.
 *
 * A successful share leaves the community feed stale for anyone holding it —
 * see `communityDirty.ts`, and mark `'feed'` at the call site, which is the
 * convention `app/(tabs)/add.tsx` already follows for `markOutfitsDirty`.
 */
export async function sharePost(opts: SharePostOptions): Promise<DisplayPost> {
  const res = await apiRequest<{ post: PublicPost }>('/community/posts', {
    method: 'POST',
    token: opts.token,
    body: { outfitId: opts.outfitId, caption: opts.caption },
  });
  return toDisplayPost(res.post);
}

/**
 * Like a post.
 *
 * **Idempotent server-side** and that is not this client's doing: a unique
 * `{ postId, userId }` index means the counter moves only when the row is
 * actually inserted, so a second tap answers identically and inflates nothing.
 * What that does NOT protect is a client's own local count, which is why
 * `usePostList` (in `postInteractions.ts`) guards its own state as well.
 *
 * Ids are encoded rather than interpolated: an id that is not a well-formed
 * ObjectId should reach the route and get its 404 rather than silently
 * addressing some other path.
 */
export async function likePost(id: string, token: string | null): Promise<PostLikeResult> {
  return apiRequest<PostLikeResult>(`/community/posts/${encodeURIComponent(id)}/like`, {
    method: 'POST',
    token,
  });
}

/**
 * Unlike a post.
 *
 * Also idempotent: the decrement happens only when a like row was actually
 * removed, so unliking twice — or unliking a post you never liked — moves
 * nothing and answers with the count as it stands.
 */
export async function unlikePost(id: string, token: string | null): Promise<PostLikeResult> {
  return apiRequest<PostLikeResult>(`/community/posts/${encodeURIComponent(id)}/like`, {
    method: 'DELETE',
    token,
  });
}

/** Save a post to the viewer's own list. Idempotent for the same reason a like
 *  is, minus the counter: a save is private to the saver. */
export async function savePost(id: string, token: string | null): Promise<PostSaveResult> {
  return apiRequest<PostSaveResult>(`/community/posts/${encodeURIComponent(id)}/save`, {
    method: 'POST',
    token,
  });
}

/** Remove a post from the viewer's own saved list. */
export async function unsavePost(id: string, token: string | null): Promise<PostSaveResult> {
  return apiRequest<PostSaveResult>(`/community/posts/${encodeURIComponent(id)}/save`, {
    method: 'DELETE',
    token,
  });
}

/**
 * Delete one of your OWN posts. 204, no body.
 *
 * Owner-scoped server-side, with the ownership in the delete filter rather
 * than checked after a load — so a foreign post, a post that never existed and
 * a malformed id all answer the same 404 and none of them tells the caller
 * which it was.
 */
export async function deletePost(id: string, token: string | null): Promise<void> {
  await apiRequest<unknown>(`/community/posts/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    token,
  });
}
