import mongoose, { Schema, model, type Document, type Model, type Types } from 'mongoose';

export interface PostLikeDoc extends Document {
  _id: Types.ObjectId;
  postId: Types.ObjectId;
  userId: Types.ObjectId;
  createdAt: Date;
}

/**
 * One user's like of one post.
 *
 * A ROW PER LIKE, with `CommunityPost.likeCount` as the denormalised counter
 * beside it. Both are needed and neither replaces the other: the counter is
 * what a feed page renders without N count queries, and these rows are what
 * make "have *I* liked this?" answerable and what make the counter
 * idempotent.
 */
const postLikeSchema = new Schema(
  {
    postId: { type: Schema.Types.ObjectId, ref: 'CommunityPost', required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
);

// IDEMPOTENCY LIVES HERE, NOT IN THE ROUTE (ruling 3).
//
// A read-then-write in the route ("is there a like already? no — insert and
// increment") has a race: two taps in the same frame both read "no" and both
// increment, and TC-12's "like count increments" becomes "increments by two".
// This project has already shipped that exact double-submit defect twice.
// A unique index makes the second insert fail at the database no matter how
// the route is written, so the route can upsert and increment only when the
// upsert actually inserted.
//
// COMPOUND, and the order matters. `postId` first is also the prefix a feed
// page uses — `{ postId: { $in: pageIds }, userId: viewer }` — so one index
// serves both the uniqueness constraint and the viewer's own `liked` flags.
postLikeSchema.index({ postId: 1, userId: 1 }, { unique: true });

export const PostLike =
  (mongoose.models.PostLike as Model<PostLikeDoc> | undefined) ??
  model<PostLikeDoc>('PostLike', postLikeSchema);
