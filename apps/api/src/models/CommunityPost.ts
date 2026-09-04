import mongoose, { Schema, model, type Document, type Model, type Types } from 'mongoose';
import {
  MAX_CAPTION_LENGTH,
  type PostAuthor,
  type PublicClothingItem,
  type PublicPost,
} from '@wardrobe/shared';
import type { UserDoc } from './User';

export interface CommunityPostDoc extends Document {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  outfitId: Types.ObjectId;
  itemIds: Types.ObjectId[];
  caption: string;
  likeCount: number;
  createdAt: Date;
}

const communityPostSchema = new Schema(
  {
    // The author. A ref, never a denormalised copy of their name (ruling 5):
    // Phase 3 claims "user profile display on posts" in the present tense, and
    // a name snapshotted at share time is wrong the moment anyone renames.
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    // PROVENANCE ONLY. It records which outfit was shared; it is never read
    // through to render the post (ruling 4). The moment a read path resolves
    // this ref for items, deleting the source outfit blanks a public post —
    // which is the exact failure `itemIds` below exists to prevent.
    outfitId: { type: Schema.Types.ObjectId, ref: 'Outfit', required: true },
    itemIds: {
      // A SNAPSHOT of the outfit's items, taken at share time and ORDERED:
      // the array position is the composition order the author chose, the
      // same ordering `Outfit.itemIds` documents. It is copied so that a post
      // outlives the outfit it came from.
      type: [{ type: Schema.Types.ObjectId, ref: 'ClothingItem' }],
      required: true,
      validate: {
        // `required: true` does NOT reject `[]` on a Mongoose array — an empty
        // array is present, so it satisfies required and stores happily. This
        // validator is what actually enforces non-empty, and without it a post
        // with nothing to render is a legal document.
        validator: (ids: Types.ObjectId[]) => ids.length > 0,
        message: 'A post must snapshot at least one item',
      },
    },
    caption: {
      type: String,
      required: true,
      // Trim BEFORE the bound, as `POST /outfits` does for a name: 284
      // characters of padding around 280 is a 280-character caption.
      trim: true,
      maxlength: MAX_CAPTION_LENGTH,
    },
    // DENORMALISED, deliberately: a feed page must not run one count query per
    // post. It is only ever moved by the like/save routes, which increment it
    // exactly when a like actually inserts (ruling 3), so a double tap cannot
    // inflate it.
    //
    // `min: 0` is a floor on VALIDATED writes only — `create()` and `save()`.
    // MEASURED, NOT ASSUMED, against mongod 8.2.12 in a scratch database:
    // `updateOne(..., { $inc: { likeCount: -1 } })` drove the counter to -1,
    // and it did so EVEN WITH `runValidators: true`, because Mongoose runs
    // update validators against `$set`-style paths and a `$inc` presents no
    // value for `min` to check. So this bound cannot be the floor for the
    // unlike path: THAT ROUTE MUST GATE ITS OWN DECREMENT (on a delete that
    // actually removed a row), and a test asserting "likeCount never goes
    // below 0" that only ever calls the route proves nothing about this line.
    likeCount: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true },
);

// The feed's keyset sort (Ruling 2: posts from ALL users, so there is no
// `userId` prefix — a `{ userId: 1, createdAt: -1 }` index copied from
// `Outfit` would serve a query this feed must never make). `_id` is not
// decoration: without it two posts created in the same millisecond can
// straddle a page boundary and one is silently dropped or repeated.
communityPostSchema.index({ createdAt: -1, _id: -1 });

// "This user's posts": the delete-your-own-post path, and a profile listing.
// Deliberately separate from the sort index above rather than folded into it,
// because the feed must not be able to reach for a user-scoped index by
// accident.
communityPostSchema.index({ userId: 1 });

// Guarded like User, ClothingItem and Outfit: re-evaluating this module
// against a shared mongoose instance would otherwise throw OverwriteModelError.
export const CommunityPost =
  (mongoose.models.CommunityPost as Model<CommunityPostDoc> | undefined) ??
  model<CommunityPostDoc>('CommunityPost', communityPostSchema);

/**
 * Shape a user record as the author of a post.
 *
 * Separate from `toPublicUser` on purpose: that one carries an email address,
 * and the community feed is the one place in this API where one user's record
 * is handed to a different user. Reusing it would leak every author's email
 * into every feed page, and nothing in the shape would say so.
 *
 * Resolving the user is the CALLER's job, not this function's. The create path
 * has one user to load; a feed page has one query for the whole page. A mapper
 * that fetched would turn the second into N round trips.
 */
export function toPostAuthor(doc: UserDoc): PostAuthor {
  return {
    id: String(doc._id),
    name: doc.name,
    // Present only when actually set, never present-with-value-undefined —
    // the same treatment `toPublicUser` gives it, so a client cannot tell the
    // two apart and start branching on which it got.
    ...(doc.avatarUrl ? { avatarUrl: doc.avatarUrl } : {}),
  };
}

/**
 * Shape a post for the wire.
 *
 * ALL FOUR EXTRAS ARE PARAMETERS, INCLUDING `liked` AND `saved`, AND THAT IS
 * DELIBERATE FROM THE FIRST CALLER. `POST /community/posts` can only ever pass
 * `false` for both — you have not liked a post you created a millisecond ago —
 * so the natural first implementation would hard-code them and the feed would
 * then have to change this signature. A shape that changes under a later task
 * is how an earlier caller quietly keeps returning an earlier truth; the
 * signature is fixed here so the feed and the like endpoint add CALLERS.
 *
 * Nothing here queries. `items` costs a lookup plus one signing round trip per
 * item, `author` costs a lookup, and `liked`/`saved` cost a query each — none
 * of which belongs in a pure mapping, and all of which a feed page must batch
 * across the whole page rather than repeat per post.
 *
 * `items` may be SHORTER than `doc.itemIds`, and may be empty. That is not an
 * error: items get deleted from wardrobes after a post is shared, and a post
 * whose every item is gone still renders with its caption and its author
 * (ruling 4). Both are returned so a client can see the gap.
 *
 * `outfitId` is deliberately NOT on the wire. It is provenance, the post is a
 * snapshot rather than a view of the outfit, and publishing it would hand one
 * user an id for another user's private resource with nothing to render from.
 */
export function toPublicPost(
  doc: CommunityPostDoc,
  extras: {
    items: PublicClothingItem[];
    author: PostAuthor;
    liked: boolean;
    saved: boolean;
  },
): PublicPost {
  return {
    id: String(doc._id),
    author: extras.author,
    itemIds: doc.itemIds.map((id) => String(id)),
    items: extras.items,
    caption: doc.caption,
    likeCount: doc.likeCount,
    liked: extras.liked,
    saved: extras.saved,
    createdAt: doc.createdAt.toISOString(),
  };
}
