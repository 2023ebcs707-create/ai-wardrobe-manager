import mongoose, { Schema, model, type Document, type Model, type Types } from 'mongoose';
import { LAUNDRY_STATUSES, type LaundryStatus as LaundryStatusValue } from '@wardrobe/shared';

/**
 * One laundry TRANSITION -- ruling 2, from spec section 4.
 *
 * Read literally, Phase 2's `LaundryStatus` entity is a single-field table
 * that would obviously be a column on `ClothingItem`. Phase 3 nonetheless
 * lists it among the collections, and the resolution the spec takes is to make
 * it a log of status *changes* (`itemId`, `status`, `changedAt`), which gives
 * laundry history for free. The current status stays denormalised onto
 * `ClothingItem.laundryStatus` so the wardrobe grid remains a single-hop read
 * rather than a per-tile lookup of "what was the most recent transition".
 *
 * Both are written by `PATCH /items/:id/laundry`, in that order, and a test
 * asserts they cannot diverge. Nothing else in this system writes either one.
 */
export interface LaundryStatusDoc extends Document {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  itemId: Types.ObjectId;
  status: LaundryStatusValue;
  changedAt: Date;
}

const laundryStatusSchema = new Schema(
  {
    // NOT in spec section 4's field list, which names only `itemId`, `status`
    // and `changedAt`. Denormalised here deliberately, and this is the one
    // addition this model makes to the documented schema.
    //
    // FUTURE-PROOFING, stated as such: NOTHING READS THIS LOG TODAY. The
    // honest claim is not "this is how the history query gets scoped" -- there
    // is no history query -- it is that when one arrives, scoping it must not
    // require a join through `ClothingItem` first. That join is precisely the
    // shape of scoping that gets forgotten: nobody omits an ownership check
    // outright, they write the lookup and forget the join. `WearHistory`
    // carries `userId` for the same reason (there it is also spec'd), and the
    // cost of being wrong is twelve bytes a row.
    //
    // Two things the first reader must do, neither of which is done here:
    //
    //   1. ADD THE INDEX. The only index below is `{ itemId, changedAt }`, so
    //      a `find({ userId })` history query would collection-scan. The index
    //      belongs with the reader, not ahead of it -- an index for a query
    //      nobody makes is write cost for nothing.
    //   2. Decide what happens if item ownership can ever transfer. Nothing
    //      in this system transfers an item today, but if that changes, this
    //      copy goes stale and nothing forces it to agree with
    //      `ClothingItem.userId`. The log is a record of who acted, which may
    //      or may not be the answer a future query wants.
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    itemId: { type: Schema.Types.ObjectId, ref: 'ClothingItem', required: true },
    // Guarded by the shared array, never by a hand-written literal pair --
    // see LAUNDRY_STATUSES in `@wardrobe/shared`. A copy here could drift from
    // the union the route validates against and from the one the client
    // renders, and the drifted copy would be the one nobody was looking at.
    status: { type: String, required: true, enum: LAUNDRY_STATUSES },
    // Required with no default, so a writer that forgets to date a transition
    // gets a ValidationError rather than a row silently dated "now".
    //
    // Unreachable from the API, distinguishable at the model layer -- the same
    // distinction `WearHistory.wornAt` documents. The only writer stamps this
    // before it creates anything, so no HTTP request can reach the path
    // without a value; `LaundryStatus.create()` with none tells `required:
    // true` apart from `required: true, default: Date.now`, and that is what
    // the model-layer test in `itemsLaundry.integration.test.ts` pins.
    changedAt: { type: Date, required: true },
  },
  { timestamps: true },
);

// Spec section 4's `itemId` index, with the history sort key appended: the
// question this log exists to answer is "what happened to THIS item, most
// recent first". `itemId` alone is a prefix of this one, so this satisfies
// the documented index rather than adding a second one beside it.
laundryStatusSchema.index({ itemId: 1, changedAt: -1 });

// Guarded like User, ClothingItem, Outfit and WearHistory: re-evaluating this
// module against a shared mongoose instance would otherwise throw
// OverwriteModelError.
export const LaundryStatus =
  (mongoose.models.LaundryStatus as Model<LaundryStatusDoc> | undefined) ??
  model<LaundryStatusDoc>('LaundryStatus', laundryStatusSchema);
