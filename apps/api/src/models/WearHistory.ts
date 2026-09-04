import mongoose, { Schema, model, type Document, type Model, type Types } from 'mongoose';
import type { PublicWearEvent } from '@wardrobe/shared';

export interface WearHistoryDoc extends Document {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  outfitId: Types.ObjectId;
  itemIds: Types.ObjectId[];
  wornAt: Date;
  occasion?: string;
}

const wearHistorySchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    outfitId: { type: Schema.Types.ObjectId, ref: 'Outfit', required: true },
    // The outfit's composition at the moment it was worn, copied here on
    // write. Every path that has to say WHAT was worn reads this array and
    // never the outfit, because the outfit may since have been edited or
    // deleted. See PublicWearEvent.itemIds.
    //
    // Named explicitly rather than left to inference, like ClothingItem's
    // `share` and `aiCategory`: Mongoose's default strict mode silently drops
    // any path the schema does not declare, so an undeclared field here would
    // be written by the route, vanish on save, and read back as an event that
    // cannot describe itself, with nothing failing anywhere.
    itemIds: [{ type: Schema.Types.ObjectId, ref: 'ClothingItem', required: true }],
    // Required with no default, so a writer that forgets to date an event
    // gets a ValidationError rather than a row silently dated "now".
    //
    // Unreachable from the API, distinguishable at the model layer -- the two
    // are not the same thing, and it is worth being precise about which this
    // is. The only writer today is `POST /wear-history`, which resolves and
    // validates `wornAt` before it creates anything, so no HTTP request can
    // reach this path without one: adding `default: Date.now` here failed
    // every integration test's assertions not at all. It is still perfectly
    // observable one layer down, where `WearHistory.create()` with no `wornAt`
    // tells the two spellings apart, and that is what the model-layer test in
    // `routes/wearHistory.integration.test.ts` pins.
    wornAt: { type: Date, required: true },
    // Optional, and stored absent rather than as '' when blank -- the same
    // one-state-not-two treatment Outfit.name gets.
    occasion: { type: String },
  },
  { timestamps: true },
);

// The list sort. `wornAt`, not `createdAt`: a back-dated entry belongs where
// it happened, not where it was typed. The `_id` tiebreaker is not decoration
// -- without it two events logged in the same millisecond can straddle a page
// boundary and one is silently dropped.
wearHistorySchema.index({ userId: 1, wornAt: -1, _id: -1 });
// Promised by spec §4, and Stage 7's suggestion engine will ask "when was this
// outfit last worn".
wearHistorySchema.index({ outfitId: 1 });

// Guarded like User, ClothingItem and Outfit: re-evaluating this module
// against a shared mongoose instance would otherwise throw OverwriteModelError.
export const WearHistory =
  (mongoose.models.WearHistory as Model<WearHistoryDoc> | undefined) ??
  model<WearHistoryDoc>('WearHistory', wearHistorySchema);

/**
 * Shape a wear event for the wire.
 *
 * `outfitName` is passed in rather than derived here because deriving it needs
 * a database lookup, and the list endpoint resolves a whole page's names in
 * one query rather than one per row. It is `undefined` — and therefore absent
 * from the response — when the outfit no longer exists: ruling 3 says a
 * deleted outfit does not un-happen the wear, so the event still lists, using
 * its own snapshotted `itemIds` to describe itself.
 */
export function toPublicWearEvent(doc: WearHistoryDoc, outfitName?: string): PublicWearEvent {
  const withTimestamps = doc as WearHistoryDoc & { createdAt: Date };
  return {
    id: String(doc._id),
    userId: String(doc.userId),
    outfitId: String(doc.outfitId),
    ...(outfitName ? { outfitName } : {}),
    itemIds: doc.itemIds.map((id) => String(id)),
    wornAt: doc.wornAt.toISOString(),
    ...(doc.occasion ? { occasion: doc.occasion } : {}),
    createdAt: withTimestamps.createdAt.toISOString(),
  };
}
