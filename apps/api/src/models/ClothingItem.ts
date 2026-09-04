import mongoose, {
  Schema,
  type InferSchemaType,
  type HydratedDocument,
  type SortOrder,
} from 'mongoose';
import {
  ITEM_CATEGORIES,
  LAUNDRY_STATUSES,
  SEASONS,
  type PublicClothingItem,
} from '@wardrobe/shared';

const colorSchema = new Schema(
  {
    hex: { type: String, required: true },
    name: { type: String, required: true },
    // The TC-05 confidence signal (Phase 3 §3.2): fraction of the image this
    // colour cluster covers, 0..1. Optional so colours from before this
    // stage, and any AI response that omits it, remain valid. Left
    // undeclared here, Mongoose's default strict mode would silently drop it
    // on write -- so it must be named explicitly, not inferred.
    share: { type: Number },
  },
  { _id: false },
);

const clothingItemSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    imageKey: { type: String, required: true },
    thumbnailKey: { type: String },
    category: { type: String, required: true, enum: ITEM_CATEGORIES },
    colors: { type: [colorSchema], default: [] },
    seasons: { type: [String], enum: SEASONS, default: [] },
    // Guarded by the shared array rather than a second hand-written copy of
    // the two literals -- see LAUNDRY_STATUSES in `@wardrobe/shared`. This is
    // the DENORMALISED current status; the transitions that produced it live
    // in the `LaundryStatus` log, and `PATCH /items/:id/laundry` writes both.
    laundryStatus: { type: String, enum: LAUNDRY_STATUSES, default: 'available' },
    wearCount: { type: Number, default: 0 },
    lastWornAt: { type: Date },
    source: { type: String, enum: ['manual', 'ai'], required: true },
    aiConfidence: { type: Number },
    // The category the MODEL assigned, kept beside the one the item is filed
    // under now. `PATCH /items/:id` writes `category` and nothing else, so
    // this is the only record that a user ever overrode the AI -- see the
    // field's documentation in `packages/shared/src/items.ts`.
    //
    // Declared explicitly, like `share` above and for the same reason:
    // Mongoose's default strict mode silently drops any path the schema does
    // not name, so an undeclared field here would be written by the route,
    // vanish on save, and read back as "the AI never suggested anything"
    // with nothing failing anywhere.
    //
    // No `enum: ITEM_CATEGORIES` guard, deliberately. `category` carries one
    // because a client supplies it; this is written only from a `tagImage`
    // result that `tagClient` has already checked against ITEM_CATEGORIES,
    // and a validation error here would fail the whole upload over a field
    // that is an annotation rather than a requirement.
    aiCategory: { type: String },
  },
  { timestamps: true },
);

clothingItemSchema.index({ userId: 1, category: 1 });

// The wardrobe list sort (Stage 4, FR4/TC-06): newest first, with _id
// breaking ties inside the same millisecond so keyset pagination cannot
// straddle a page boundary. { userId: 1, category: 1 } does not serve it -- a
// category-filtered page still has to sort by createdAt, and without this
// index that is an in-memory sort of the whole matched set.
clothingItemSchema.index({ userId: 1, createdAt: -1, _id: -1 });

// The `GET /analytics/usage` ranking (Stage 6, FR6): most/least worn.
//
// Ruling 4 says analytics rank on this counter rather than aggregating the
// wear log, and "one indexed query" is only true if an index actually serves
// the sort -- neither index above does, since `wearCount` appears in neither.
// Without this, both halves of every analytics request are a collection scan
// plus an in-memory sort of the caller's whole wardrobe.
//
// `leastWorn` sorts ASCENDING on all three keys, which is the exact reverse of
// this index, so MongoDB walks the same index backwards for it rather than
// needing a second, mirrored one. That is why the two lists are exact
// reverses of each other and not, say, ascending on wearCount but descending
// on the tiebreakers -- the sort spec is what makes one index enough.
//
// `lastWornAt` and `_id` are in the key, not decoration: they are the
// tiebreakers that make both lists stable across calls, and a sort the index
// cannot fully satisfy reintroduces the in-memory SORT stage this exists to
// remove. `analytics.integration.test.ts` asserts the winning plan is an
// IXSCAN on this index with no SORT stage.
clothingItemSchema.index({ userId: 1, wearCount: -1, lastWornAt: -1, _id: -1 });

/**
 * The two orderings `GET /analytics/usage` ranks by, declared HERE rather than
 * in the route, immediately beside the index that has to serve them.
 *
 * They are two halves of one fact. `WEAR_RANK_INDEX` is only an index for
 * these sorts while its key list mirrors them, and a sort key added in the
 * route with no matching index change is silently a full in-memory sort of
 * the caller's wardrobe -- fast on a test fixture, and never fast again.
 * Putting the two next to each other means a change to one is visibly a
 * change to the other.
 *
 * LEAST_WORN_SORT is the EXACT reverse of MOST_WORN_SORT, on every key.
 * That is what lets one index answer both: MongoDB walks it backwards for the
 * ascending case. Ascending on `wearCount` but descending on a tiebreaker
 * would need a second, mirrored index to stay indexed.
 *
 * `lastWornAt` then `_id` are the tiebreakers that make both lists stable
 * across calls -- without them, two items with equal `wearCount` come back in
 * whatever order the storage engine hands them over, and a Profile screen that
 * re-fetches shuffles rows for no reason the user can see.
 */
export const MOST_WORN_SORT: Record<string, SortOrder> = {
  wearCount: -1,
  lastWornAt: -1,
  _id: -1,
};
export const LEAST_WORN_SORT: Record<string, SortOrder> = {
  wearCount: 1,
  lastWornAt: 1,
  _id: 1,
};

/** The name MongoDB gives the index above; asserted on by the explain test. */
export const WEAR_RANK_INDEX = 'userId_1_wearCount_-1_lastWornAt_-1__id_-1';

export type ClothingItemAttrs = InferSchemaType<typeof clothingItemSchema>;
export type ClothingItemDoc = HydratedDocument<ClothingItemAttrs>;

export const ClothingItem =
  mongoose.models.ClothingItem ?? mongoose.model('ClothingItem', clothingItemSchema);

export function toPublicItem(doc: ClothingItemDoc, imageUrl: string, thumbnailUrl?: string): PublicClothingItem {
  const withTimestamps = doc as ClothingItemDoc & { createdAt: Date };
  return {
    id: String(doc._id),
    userId: String(doc.userId),
    imageUrl,
    ...(thumbnailUrl ? { thumbnailUrl } : {}),
    category: doc.category as PublicClothingItem['category'],
    colors: doc.colors.map((c) => ({
      hex: c.hex,
      name: c.name,
      // Present only when actually set, not present-with-value-undefined --
      // matches the aiConfidence/lastWornAt/thumbnailUrl pattern below, and
      // keeps colours persisted before this stage (no `share` at all)
      // indistinguishable from ones the AI service genuinely omitted it for.
      ...(c.share !== undefined && c.share !== null ? { share: c.share } : {}),
    })),
    seasons: doc.seasons as PublicClothingItem['seasons'],
    laundryStatus: doc.laundryStatus as PublicClothingItem['laundryStatus'],
    wearCount: doc.wearCount,
    ...(doc.lastWornAt ? { lastWornAt: doc.lastWornAt.toISOString() } : {}),
    source: doc.source as PublicClothingItem['source'],
    ...(doc.aiConfidence !== undefined && doc.aiConfidence !== null
      ? { aiConfidence: doc.aiConfidence }
      : {}),
    // Present only when a model actually assigned one -- same
    // absent-not-undefined treatment as aiConfidence above. The distinction
    // matters more here than elsewhere: a client must be able to tell "the AI
    // suggested nothing we recorded" from "the AI suggested exactly this",
    // because it is `aiCategory === category` that licenses showing a
    // confidence next to a category.
    ...(doc.aiCategory !== undefined && doc.aiCategory !== null
      ? { aiCategory: doc.aiCategory as PublicClothingItem['category'] }
      : {}),
    createdAt: withTimestamps.createdAt.toISOString(),
  };
}
