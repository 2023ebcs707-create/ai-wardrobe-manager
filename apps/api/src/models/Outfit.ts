import mongoose, { Schema, model, type Document, type Model, type Types } from 'mongoose';
import type {
  PublicClothingItem,
  PublicOutfit,
  PublicOutfitDetail,
} from '@wardrobe/shared';

export interface OutfitDoc extends Document {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  name?: string;
  itemIds: Types.ObjectId[];
}

const outfitSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    // Optional by design: neither FR5 nor TC-07 requires naming an outfit.
    // Stored absent rather than as '' when blank, so "has no name" is one
    // state rather than two that render differently.
    name: { type: String },
    // Ordered. The array position IS the composition order the user chose,
    // and it is meaningful: "top, trousers, shoes" reads correctly and the
    // same three ids in another order do not. Mongoose preserves array order
    // on write; what does NOT preserve it is reading the items back with a
    // `$in` query, which returns index order — so every read path reapplies
    // this ordering deliberately.
    itemIds: [{ type: Schema.Types.ObjectId, ref: 'ClothingItem', required: true }],
  },
  { timestamps: true },
);

// The list sort, matching ClothingItem's. The `_id` tiebreaker is not
// decoration: without it, two outfits created in the same millisecond can
// straddle a page boundary and one is silently dropped or repeated.
outfitSchema.index({ userId: 1, createdAt: -1, _id: -1 });

// Promised by the spec's data-model table, and Stage 7's suggestion engine
// will query outfits by the items they contain.
outfitSchema.index({ itemIds: 1 });

// Guarded like User and ClothingItem: re-evaluating this module against a
// shared mongoose instance would otherwise throw OverwriteModelError.
export const Outfit =
  (mongoose.models.Outfit as Model<OutfitDoc> | undefined) ??
  model<OutfitDoc>('Outfit', outfitSchema);

/**
 * The fields the list and detail shapes share: everything except the cover
 * and the resolved items.
 *
 * Both public shapes are built from this rather than each restating the
 * mapping, so a change to how an outfit is presented cannot land on one
 * endpoint and miss the other.
 */
function outfitBase(doc: OutfitDoc): Omit<PublicOutfit, 'coverUrl'> {
  const withTimestamps = doc as OutfitDoc & { createdAt: Date };
  const itemIds = doc.itemIds.map((id) => String(id));
  return {
    id: String(doc._id),
    userId: String(doc.userId),
    ...(doc.name ? { name: doc.name } : {}),
    itemIds,
    itemCount: itemIds.length,
    createdAt: withTimestamps.createdAt.toISOString(),
  };
}

/**
 * Shape an outfit for the wire.
 *
 * `coverUrl` is passed in rather than derived here because deriving it needs
 * both a database lookup and a signing round trip — neither belongs in a pure
 * mapping function, and the list endpoint signs a whole page concurrently.
 */
export function toPublicOutfit(doc: OutfitDoc, coverUrl?: string): PublicOutfit {
  return { ...outfitBase(doc), ...(coverUrl ? { coverUrl } : {}) };
}

/**
 * Shape an outfit and its resolved items for the detail endpoint.
 *
 * `items` is passed in for the same reason `coverUrl` is: resolving it needs a
 * query and one signing round trip per item. It may be shorter than `itemIds`
 * when an item no longer resolves, and `itemCount` deliberately counts the
 * ids rather than the items — the outfit still references that many things,
 * and returning both is what lets a client see the gap.
 */
export function toPublicOutfitDetail(
  doc: OutfitDoc,
  items: PublicClothingItem[],
): PublicOutfitDetail {
  return { ...outfitBase(doc), items };
}
