import type { PublicClothingItem } from './items';

/**
 * The caption bound `POST /community/posts` enforces, applied AFTER trimming.
 *
 * It lives here rather than in the route for the same reason
 * `MAX_OUTFIT_NAME_LENGTH` does: the share sheet has to refuse the 281st
 * character locally, and the API has to refuse it again. Two copies of one
 * bound drift silently and asymmetrically — a composer that allows more than
 * the API does turns the share button into an unretryable dead end, and one
 * that allows less refuses keystrokes the server would have taken.
 *
 * 280 is a deliberate choice, not an arbitrary one: a caption is a single
 * line under a photograph, not a post body, and the mobile card lays out for
 * roughly four lines of text.
 */
export const MAX_CAPTION_LENGTH = 280;

/**
 * The author of a community post, as rendered on a card.
 *
 * POPULATED AT READ TIME, NEVER DENORMALISED ONTO THE POST (ruling 5). The
 * post stores a `userId` ref and every read resolves it, so a user who
 * changes their name has the new name on old posts. Phase 3 claims "user
 * profile display on posts" in the present tense, and a snapshot of a name
 * taken at share time makes that claim false the first time anyone edits
 * their profile.
 *
 * `email` is deliberately absent. A community feed is the one place in this
 * API where one user's record is handed to another user, and an email address
 * is not needed to draw a card. `PublicUser` carries one; this type is not
 * `PublicUser` precisely so that the feed cannot leak one by inheriting it.
 */
export interface PostAuthor {
  id: string;
  /**
   * The author's display name. Always present — `User.name` is required — and
   * it is the input the initials avatar is derived from when `avatarUrl` is
   * absent, which is every user today (ruling 6).
   */
  name: string;
  /**
   * Present only when the user actually has one.
   *
   * NOTHING IN THIS SYSTEM EVER SETS IT. `User.avatarUrl` exists on the
   * schema, no upload flow writes it, and no submitted document claims one.
   * It is carried anyway because the field is real and a future upload flow
   * must not need a wire change — but a client that renders "avatar or blank
   * circle" renders a blank circle for every post in the product as it
   * stands. Render a deterministic initials avatar derived from `name` when
   * this is absent; an initials avatar is an avatar, an empty hole is not.
   */
  avatarUrl?: string;
}

/**
 * FR9 / FR10, TC-11 / TC-12: one shared outfit as it appears in the community
 * feed, and as `POST /community/posts` hands it straight back.
 *
 * THE CREATE RESPONSE AND THE FEED RETURN THE SAME SHAPE, deliberately: a
 * client that has just shared can render the new card without refetching, and
 * one renderer serves both. That is why `liked` and `saved` are present on a
 * post that was created a millisecond ago and can only be `false`.
 *
 * There is no `outfitId`. The post's provenance is stored server-side, but a
 * post is NOT a view of its outfit: it snapshots the item ids at share time
 * (ruling 4), so deleting the source outfit leaves the post intact, and
 * reading through to the outfit would both undo that and hand one user an id
 * belonging to another user's private resource for no rendering benefit.
 *
 * `itemIds` AND `items` ARE NOT PARALLEL ARRAYS — `items` is compacted and
 * `itemIds` is not, exactly as on `PublicSuggestion`. Read both field
 * comments before indexing either.
 */
export interface PublicPost {
  id: string;
  /** Resolved from the post's `userId` on every read — see `PostAuthor`. */
  author: PostAuthor;
  /**
   * EVERY item id the post snapshotted, in the order the author composed the
   * outfit, INCLUDING ids that no longer resolve.
   *
   * A SNAPSHOT, NOT A REFERENCE (ruling 4). It is copied from the outfit at
   * share time and never re-read from it, so deleting the source outfit does
   * not blank a public post. The order is the composer's — "top, trousers,
   * shoes" reads correctly and the same three ids in another order do not —
   * and it survives the copy, so `items` below can be rendered in it.
   *
   * Kept uncompacted so a client can see that a gap exists. It is NOT a list
   * of things a client may fetch: these ids belong to another user's
   * wardrobe, and `GET /items/:id` answers 404 for every one of them.
   */
  itemIds: string[];
  /**
   * The resolved items with signed image URLs, in `itemIds` order but
   * COMPACTED: an id that no longer resolves is dropped, so `items` may be
   * SHORTER than `itemIds` and `items[i]` does NOT in general correspond to
   * `itemIds[i]`.
   *
   * ALSO DE-DUPLICATED, and `itemIds` is not. A post whose snapshot names the
   * same id twice — reachable only by a direct database write, since
   * `POST /outfits` answers 400 for a duplicate — yields ONE element here, at
   * the id's FIRST position, while `itemIds` keeps both occurrences because it
   * is a faithful record of what was shared. This is what makes `item.id` a
   * safe `keyExtractor` for the card's list: two elements sharing one key is a
   * defect in any keyed list, and no client should have to de-duplicate a
   * server's render list to avoid it. Both endpoints answer the same way —
   * `POST /community/posts` and `GET /community/posts` resolve items through
   * one helper, and an API test holds each of them to it separately.
   *
   * RENDER FROM `items`, ALWAYS — every element carries its own `id`. Never
   * index `itemIds` in parallel with it: one unresolved id puts every later
   * pairing off by one, and the card then shows the wrong garment.
   *
   * MAY BE EMPTY, AND AN EMPTY `items` IS NOT AN ERROR. Items can be deleted
   * from a wardrobe after a post is shared; when the last one goes the post
   * still exists and still renders, with its caption and its author (ruling
   * 4). A feed that 404s or 500s on such a post develops holes as users tidy
   * their wardrobes. `POST /community/posts` refuses to create a post from an
   * outfit that has no item ids at all, which is a different thing.
   */
  items: PublicClothingItem[];
  /**
   * The author's caption. Trimmed, never blank, at most
   * `MAX_CAPTION_LENGTH` characters.
   *
   * Required, not optional: TC-11 shares "with caption" and Phase 3 §3.1 says
   * "with captions". An optional caption would make the card's empty state a
   * second thing to design for a field the documents say is always there.
   */
  caption: string;
  /**
   * How many distinct users have liked this post.
   *
   * A DENORMALISED COUNTER, not a count of `PostLike` rows computed per read.
   * It is incremented only when a like actually inserts (ruling 3) — the
   * unique `{ postId, userId }` index is what makes the second tap of a
   * double tap a no-op rather than a second increment. TC-12 claims "like
   * count increments"; a count that increments by two on one double tap
   * makes that claim false.
   */
  likeCount: number;
  /**
   * Whether the VIEWER of this response has liked the post. Never whether the
   * author has.
   *
   * Viewer-relative, so the same post has different values in two users'
   * feeds. `POST /community/posts` always returns `false` — you have not
   * liked a post you created a millisecond ago — and the parameter exists on
   * the mapper from the first task anyway, so that the tasks which add the
   * feed and the like endpoint add CALLERS rather than change this shape.
   */
  liked: boolean;
  /** Whether the VIEWER has saved this post. Viewer-relative, like `liked`. */
  saved: boolean;
  createdAt: string;
}
