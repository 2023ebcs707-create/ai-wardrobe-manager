import type { PublicClothingItem } from './items';

/**
 * The bounds `POST /outfits` and `PATCH /outfits/:id` enforce, shared rather
 * than restated in each layer.
 *
 * They live here, beside the types they bound, for the same reason
 * `ITEM_CATEGORIES` does: every layer that has an opinion about them must have
 * the SAME opinion, and drift is silent and asymmetric in both directions.
 *
 * - If the API tightened its bound and the composer did not, the composer
 *   would let a user build a selection that 400s — on a screen whose entire
 *   error contract is "press save again", which makes it an unretryable dead
 *   end.
 * - If the API loosened its bound and the composer did not, the composer would
 *   silently refuse taps with no feedback at all, because refusing returns the
 *   same array reference and nothing re-renders.
 *
 * A shared constant makes both impossible: one edit moves every layer.
 */

/** An outfit of nothing is not an outfit. */
export const MIN_OUTFIT_ITEMS = 1;
/** 20 bounds the detail response, which resolves every item. */
export const MAX_OUTFIT_ITEMS = 20;
/** Applied AFTER trimming: 84 characters of padding is an 80-character name. */
export const MAX_OUTFIT_NAME_LENGTH = 80;

/**
 * An outfit as returned by the list endpoint, `GET /outfits`.
 *
 * Deliberately light: a gallery cell needs a cover, a name and a count, not
 * every item's full record. `GET /outfits/:id` is the heavy read that resolves
 * the items themselves.
 */
export interface PublicOutfit {
  id: string;
  userId: string;
  /**
   * Optional. Neither FR5 nor TC-07 mentions naming an outfit, so an unnamed
   * outfit is valid and the UI supplies a neutral placeholder.
   */
  name?: string;
  /**
   * Item ids in the order the user composed them.
   *
   * The order is meaningful and is preserved on write: "top, trousers, shoes"
   * reads correctly and "shoes, top, trousers" does not. A `$in` query returns
   * documents in index order rather than request order, so the API reapplies
   * this ordering deliberately rather than inheriting it.
   */
  itemIds: string[];
  itemCount: number;
  /**
   * Signed URL for the first item's thumbnail, falling back to its full image.
   *
   * Derived at read time and never stored. The spec's data-model table lists a
   * persisted `coverImageUrl`; storing one would be a defect, because every
   * image URL in this system is presigned with a one-hour expiry — a stored
   * cover would be a dead link within the hour and dead permanently after.
   *
   * Absent when the first item cannot be resolved. That is not an error state:
   * `DELETE /items/:id` deletes an item without touching the outfits that
   * reference it (there is no cascade delete in this system), so an ordinary
   * deletion reaches this, and a gallery must degrade to a placeholder rather
   * than fail.
   */
  coverUrl?: string;
  createdAt: string;
}

/**
 * An outfit as returned by the detail endpoint, `GET /outfits/:id`.
 *
 * The heavy read, deliberately: it carries the resolved items rather than a
 * cover, because the detail screen renders their images and a client that had
 * to fetch N items separately would issue N round trips. `coverUrl` is absent
 * for the same reason it exists on `PublicOutfit` — a gallery cell needs one
 * picture, a detail screen needs all of them.
 *
 * Declared as `Omit<PublicOutfit, 'coverUrl'>` rather than restated field by
 * field so the two shapes cannot drift: everything except the cover is
 * literally the same contract.
 */
export interface PublicOutfitDetail extends Omit<PublicOutfit, 'coverUrl'> {
  /**
   * The resolved items, ordered to match `itemIds`.
   *
   * May be SHORTER than `itemIds` if an item no longer resolves. There is no
   * cascade delete in this system: `DELETE /items/:id` removes the garment and
   * leaves its id in place on every outfit that referenced it, so this is an
   * ordinary state rather than a corrupted one, and the tolerance is what
   * degrades the screen instead of 500ing it.
   */
  items: PublicClothingItem[];
}
