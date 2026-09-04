import mongoose, { Schema, model, type Document, type Model, type Types } from 'mongoose';

export interface PostSaveDoc extends Document {
  _id: Types.ObjectId;
  postId: Types.ObjectId;
  userId: Types.ObjectId;
  createdAt: Date;
}

/**
 * One user's bookmark of one post — TC-12's "post added to user's saved list".
 *
 * Deliberately its own collection rather than a `savedBy` array on the post.
 * An array grows without bound on a popular post, cannot be paginated, and
 * makes "my saved list, newest first" a scan of every post in the system. A
 * row per save is a keyset-paginable list with an index that serves it.
 *
 * The same shape as `PostLike`, and it must stay the same shape: they are two
 * instances of one idea — an interaction between one user and one post — and
 * a divergence in how they are keyed would mean the two endpoints answer
 * "already done?" by different rules. What legitimately differs is the second
 * index below, which exists because a saved list is browsed and a like list
 * is not.
 */
const postSaveSchema = new Schema(
  {
    postId: { type: Schema.Types.ObjectId, ref: 'CommunityPost', required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
);

// Idempotency from the database, exactly as on `PostLike` and for the same
// reasons (ruling 3): a double tap must not create two saves, and the route
// must not have to win a race to make that true. `postId` first is also the
// prefix a feed page uses to fill in each viewer's own `saved` flags.
postSaveSchema.index({ postId: 1, userId: 1 }, { unique: true });

// The saved list's keyset sort: `userId` equality, then newest first with
// `_id` breaking same-millisecond ties so a page boundary cannot drop or
// repeat a row. Without this index the list is a collection scan plus an
// in-memory sort of every save in the system.
//
// This is the index the unique one above cannot serve: its leading key is
// `postId`, and a list scoped to a user needs `userId` in front.
postSaveSchema.index({ userId: 1, createdAt: -1, _id: -1 });

export const PostSave =
  (mongoose.models.PostSave as Model<PostSaveDoc> | undefined) ??
  model<PostSaveDoc>('PostSave', postSaveSchema);
