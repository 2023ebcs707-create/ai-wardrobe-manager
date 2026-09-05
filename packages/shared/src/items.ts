export const ITEM_CATEGORIES = [
  'tshirt',
  'shirt',
  'trousers',
  'jacket',
  'dress',
  'skirt',
  'shorts',
  'shoes',
  'accessory',
  'other',
] as const;

export type ItemCategory = (typeof ITEM_CATEGORIES)[number];

export const SEASONS = ['spring', 'summer', 'autumn', 'winter'] as const;
export type Season = (typeof SEASONS)[number];

/**
 * The two states FR7 tracks, as a runtime array rather than a bare type union.
 *
 * `LaundryStatus` is derived FROM this array, so the literals exist in exactly
 * one place in the system. They previously existed in two: this type, and the
 * `enum:` guard on `ClothingItem.laundryStatus`, which spelled them out again
 * where nothing could check the two spellings still agreed. Stage 6 needs a
 * third runtime consumer -- `PATCH /items/:id/laundry` validates a request
 * body against them -- and a third hand-written copy is where a typo becomes a
 * status the API accepts and the wardrobe grid cannot render.
 *
 * Same shape as ITEM_CATEGORIES and SEASONS above, for the same reason.
 */
export const LAUNDRY_STATUSES = ['available', 'in_laundry'] as const;

export type LaundryStatus = (typeof LAUNDRY_STATUSES)[number];

export interface ItemColor {
  hex: string;
  name: string;
  /**
   * Fraction of the image belonging to this colour cluster, 0..1.
   *
   * This is the signal Phase 3 §3.2 was pointing at when it recorded TC-05 as
   * "reduced accuracy for multi-color/patterned items". Measured: a solid navy
   * garment yields 1.00; a two-tone stripe 0.55/0.45; a patterned print ~0.37
   * across three near-equal clusters, where "dominant colour" means nothing.
   *
   * Persisted deliberately. Stage 4's wardrobe UI and Stage 7's outfit
   * suggestions both need to distinguish a genuinely navy shirt from a floral
   * print whose top colour is an artefact, and that cannot be recovered after
   * storage without re-clustering the original image. One float.
   */
  share?: number;
}

export interface TagResult {
  category: ItemCategory;
  confidence: number;
  colours: ItemColor[];
}

export interface PublicClothingItem {
  id: string;
  userId: string;
  imageUrl: string;
  thumbnailUrl?: string;
  category: ItemCategory;
  colors: ItemColor[];
  seasons: Season[];
  laundryStatus: LaundryStatus;
  /**
   * Whether this item is in the active wardrobe — as opposed to `laundryStatus`,
   * which tracks whether a currently-active item happens to be clean right now.
   *
   * A retired item (lost, given away, sold, worn out) is excluded from
   * `POST /outfits`'s item resolution and from `GET /suggestions`'s candidate
   * pool, but is NOT hidden from the wardrobe grid or from an outfit that
   * already references it — the same "still shown, never proposed" treatment
   * this app already gives an in-laundry item, applied one layer further out.
   * See `resolveOwnedItems` in `apps/api/src/routes/outfits.ts` and the laundry
   * filter in `apps/api/src/routes/suggestions.ts`.
   */
  retired: boolean;
  wearCount: number;
  lastWornAt?: string;
  source: 'manual' | 'ai';
  aiConfidence?: number;
  /**
   * The category the model itself assigned, as distinct from `category`, which
   * is whatever the item is filed under *now*.
   *
   * Set once, when tagging succeeds, and never written again -- `PATCH
   * /items/:id` deliberately touches only `category`. That asymmetry is the
   * whole point: `source: 'ai'` survives a user's correction on purpose (it
   * records how the item was tagged, not who last touched it), which means
   * `source` alone cannot tell a category the model chose from one the user
   * chose. Without this field the detail screen renders "jacket - AI tagged -
   * AI confidence 87%" for an item the model called a shirt at 0.87 and the
   * user corrected to a jacket: a number that was never about the word beside
   * it.
   *
   * So the comparison `aiCategory === category` is the readable fact, and
   * `aiCategory !== category` is an override. That is also the only record in
   * the system that an override happened at all: nothing else stores it.
   * Stage 9's "how often do users correct the AI" question is answerable from
   * this field and from nothing else -- and it answers the stronger version,
   * *what* each item was corrected from, at the same storage cost as a
   * boolean.
   *
   * Optional because it is absent on manual items (no model ran) and on every
   * item stored before this field existed. Absent is genuinely "unknown", not
   * "not overridden" -- a reader must not infer agreement from its absence.
   */
  aiCategory?: ItemCategory;
  createdAt: string;
}
