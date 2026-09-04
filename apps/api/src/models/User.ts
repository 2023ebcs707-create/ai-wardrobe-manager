import mongoose, { Schema, type InferSchemaType, type HydratedDocument } from 'mongoose';
import type { PublicUser } from '@wardrobe/shared';

const userSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    avatarUrl: { type: String },
  },
  { timestamps: true },
);

export type UserAttrs = InferSchemaType<typeof userSchema>;
export type UserDoc = HydratedDocument<UserAttrs>;

export const User = mongoose.models.User ?? mongoose.model('User', userSchema);

export function toPublicUser(doc: UserDoc): PublicUser {
  return {
    id: String(doc._id),
    name: doc.name,
    email: doc.email,
    ...(doc.avatarUrl ? { avatarUrl: doc.avatarUrl } : {}),
    createdAt: (doc as UserDoc & { createdAt: Date }).createdAt.toISOString(),
  };
}
