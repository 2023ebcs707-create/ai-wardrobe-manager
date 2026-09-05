import mongoose, { Schema, model, type Document, type Model, type Types } from 'mongoose';
import type { PublicOutfitPlan } from '@wardrobe/shared';

export interface OutfitPlanDoc extends Document {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  outfitId: Types.ObjectId;
  itemIds: Types.ObjectId[];
  plannedFor: Date;
  occasion?: string;
}

const outfitPlanSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    outfitId: { type: Schema.Types.ObjectId, ref: 'Outfit', required: true },
    // The outfit's composition at the moment it was planned, copied here on
    // write — see `PublicOutfitPlan.itemIds`. Named explicitly rather than
    // left to inference, exactly as `WearHistory.itemIds` is: Mongoose's
    // default strict mode silently drops any path the schema does not declare.
    itemIds: [{ type: Schema.Types.ObjectId, ref: 'ClothingItem', required: true }],
    // Required with no default, for the same reason `WearHistory.wornAt` is: a
    // writer that forgets to date a plan should get a ValidationError rather
    // than a row silently dated "now" — which, for a forward-looking record,
    // would be a plan for today that nobody made.
    plannedFor: { type: Date, required: true },
    // Optional, stored absent rather than as '' when blank — the same
    // one-state-not-two treatment `Outfit.name` and `WearHistory.occasion` get.
    occasion: { type: String },
  },
  { timestamps: true },
);

// The range query `GET /outfit-plans?from=&to=` runs, and the order it returns.
// ASCENDING on `plannedFor`, unlike the wear-history index: history is read
// newest-first because it is a log of what happened, and plans are read
// soonest-first because they are a queue of what is coming. `_id` breaks ties
// so two plans for the same day come back in a stable order.
outfitPlanSchema.index({ userId: 1, plannedFor: 1, _id: 1 });

// Guarded like every other model here: re-evaluating this module against a
// shared mongoose instance would otherwise throw OverwriteModelError.
export const OutfitPlan =
  (mongoose.models.OutfitPlan as Model<OutfitPlanDoc> | undefined) ??
  model<OutfitPlanDoc>('OutfitPlan', outfitPlanSchema);

/**
 * Shape a plan for the wire.
 *
 * `outfitName` is passed in rather than derived here, for the same reason
 * `toPublicWearEvent`'s is: deriving it needs a database lookup, and the list
 * endpoint resolves a whole range's names in one query rather than one per
 * row. It is `undefined` — and therefore absent — when the outfit no longer
 * exists or never had a name; see `PublicOutfitPlan.outfitName` for why those
 * two are collapsed.
 */
export function toPublicOutfitPlan(doc: OutfitPlanDoc, outfitName?: string): PublicOutfitPlan {
  const withTimestamps = doc as OutfitPlanDoc & { createdAt: Date };
  return {
    id: String(doc._id),
    userId: String(doc.userId),
    outfitId: String(doc.outfitId),
    ...(outfitName ? { outfitName } : {}),
    itemIds: doc.itemIds.map((id) => String(id)),
    plannedFor: doc.plannedFor.toISOString(),
    ...(doc.occasion ? { occasion: doc.occasion } : {}),
    createdAt: withTimestamps.createdAt.toISOString(),
  };
}
