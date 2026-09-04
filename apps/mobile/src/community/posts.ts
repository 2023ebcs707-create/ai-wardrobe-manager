import type { PostAuthor, PublicClothingItem, PublicPost } from '@wardrobe/shared';
import { countLabel } from '../format/text';

/**
 * One community post, in the shape a card renders.
 *
 * ## `PublicPost.itemIds` is deliberately not here
 *
 * The wire type carries two arrays and **they are not parallel**. `items` is
 * compacted — an id the author's wardrobe no longer resolves is dropped from
 * `items` while `itemIds` keeps it — AND de-duplicated, while `itemIds` keeps
 * both occurrences of a repeated id. So `items` can be shorter, and
 * `items[i]` is not in general `itemIds[i]`; one unresolved id puts every
 * later pairing off by one and the card then shows the wrong garment under the
 * wrong id.
 *
 * `DisplaySuggestion` reached the same conclusion in Stage 7 for the same wire
 * shape, and the reasoning is worth repeating rather than referencing: a
 * comment saying "render from `items`" is not a control, and not handing over
 * the other array is. Every id a card needs is on `item.id`, which is also
 * what makes `item.id` a safe `keyExtractor` — the server de-duplicates
 * `items` precisely so that no client has to.
 *
 * The one thing `itemIds` was kept uncompacted FOR — letting a client see that
 * a gap exists — is carried across as `missingItemsNotice`, a sentence rather
 * than a number, for the reason `laundryNoticeFor` gives.
 *
 * ## `author.name` may be a tombstone and this layer cannot tell
 *
 * A post outlives its author: nothing cascades a user delete onto their posts,
 * so a feed page can carry `{ id, name: 'Deleted user' }` where the account is
 * gone. That string is **also a legal display name** — `registerSchema` is
 * `min(1).max(80)` with no reserved-name check — so a real user called
 * "Deleted user" is byte-identical on the wire to a tombstone.
 *
 * There is therefore no `authorDeleted` flag here, and there must not be one:
 * it could only be computed by comparing the name to a constant, and it would
 * be wrong about a real person. Render `author.name` as the name it is.
 */
export interface DisplayPost {
  id: string;
  /** Resolved on every read rather than snapshotted, so a user who changes
   *  their name has the new name on old posts. `avatarUrl` is absent for every
   *  user in the product as it stands — nothing writes it — so a card that
   *  renders "avatar or blank circle" renders a blank circle every time. */
  author: PostAuthor;
  /**
   * The garments to render, in the order the author composed the outfit, with
   * signed image URLs.
   *
   * **MAY BE EMPTY, AND EMPTY IS NOT AN ERROR.** Items can be deleted from a
   * wardrobe after a post is shared; when the last one goes the post still
   * exists and still renders, with its caption and its author. A card that
   * treats `[]` as a failure puts a hole in the feed every time somebody
   * tidies their wardrobe.
   *
   * The same `PublicClothingItem` the wardrobe grid already draws, so no new
   * renderer is needed.
   */
  items: PublicClothingItem[];
  /** Trimmed, never blank, at most `MAX_CAPTION_LENGTH` characters. */
  caption: string;
  /** How many distinct users have liked this post. */
  likeCount: number;
  /** Whether the VIEWER has liked it — never whether the author has. */
  liked: boolean;
  /** Whether the VIEWER has saved it. */
  saved: boolean;
  createdAt: string;
  /**
   * A ready-to-render sentence about garments this post was shared with that
   * no longer resolve, or `null` when every one of them is in `items`.
   *
   * Read `missingItemsNoticeFor` before touching this. The wording is a
   * constraint rather than a default, and the number behind it is NOT
   * `itemIds.length - items.length`.
   */
  missingItemsNotice: string | null;
}

/**
 * `itemIds` + `items` → the one sentence this app is allowed to build from the
 * gap between them.
 *
 * ## Why the subtraction is over DISTINCT ids
 *
 * `items` is compacted *and* de-duplicated; `itemIds` is neither. So
 * `itemIds.length - items.length` counts a collapsed duplicate as a missing
 * garment, and it is not one — the id IS rendered, once, at its first
 * position. Counting distinct ids instead makes the number exactly "how many
 * of the garments this post was shared with can no longer be resolved", which
 * is the only thing the sentence claims.
 *
 * A duplicated snapshot id is reachable only by a direct database write
 * (`POST /outfits` answers 400 for a duplicate), so the two arithmetics agree
 * on every post the product can currently produce. That is a statement about
 * today's writers, not about the shape, and the shape is documented as
 * de-duplicated on one side and faithful on the other.
 *
 * ## Why the raw count is not exposed alongside it
 *
 * For the same reason `DisplayPost` does not expose `itemIds`, and the same
 * reason `SuggestionsSnapshot` exposes a laundry sentence rather than a
 * laundry count: handing over the integer next to the sanctioned sentence
 * leaves the wrong sentence one template literal away. The number's only
 * sanctioned use IS this sentence.
 *
 * ## What the sentence may and may not say
 *
 * It states a FACT ABOUT THE POST and asserts no cause. "2 items were deleted"
 * is forbidden — this layer cannot see a deletion, only a non-resolution — and
 * so is anything implying the author removed them, or that the outfit was
 * changed. `null` at zero so a caller renders nothing rather than "0 items are
 * no longer available", which reads as a warning about a post that has none.
 *
 * ## Why the arguments are checked at runtime
 *
 * `apiRequest` ends in `parsed as T`, so the declared types are an assertion
 * about the wire rather than a guarantee from it, and this function's inputs
 * are two arrays it immediately measures. A missing key would otherwise throw
 * on `.length` inside a `map` over a feed page and take the whole list down;
 * `laundryNoticeFor` applies the same one-line defence for the same reason.
 * Not reachable through the real route, which always sends both arrays; kept
 * because "not reachable today" is a statement about today's server.
 */
export function missingItemsNoticeFor(
  itemIds: readonly string[],
  items: readonly PublicClothingItem[],
): string | null {
  if (!Array.isArray(itemIds) || !Array.isArray(items)) return null;
  const missing = new Set(itemIds).size - items.length;
  if (!Number.isFinite(missing) || missing <= 0) return null;
  return `${countLabel(missing)} ${missing === 1 ? 'is' : 'are'} no longer available`;
}

/**
 * The wire post → the card's post.
 *
 * The line that matters is the one that is absent: `itemIds` is read here, to
 * measure the gap, and never carried through. See `DisplayPost` for the two
 * bugs that having both arrays within reach produces, both of them silent.
 */
export function toDisplayPost(raw: PublicPost): DisplayPost {
  return {
    id: raw.id,
    author: raw.author,
    items: raw.items,
    caption: raw.caption,
    likeCount: raw.likeCount,
    liked: raw.liked,
    saved: raw.saved,
    createdAt: raw.createdAt,
    missingItemsNotice: missingItemsNoticeFor(raw.itemIds, raw.items),
  };
}
