import { Schema, type Document, type Types } from 'mongoose';
import { registerModel } from './registerModel.js';
import { Collections, ROLES, Role, type RoleType } from './types.js';

export interface UserDoc extends Document<Types.ObjectId> {
  _id: Types.ObjectId;
  email: string;
  passwordHash: string;
  name: string;
  role: RoleType;
  isActive: boolean;
  /** Bumped on "log out everywhere"; invalidates every outstanding token. */
  tokenVersion: number;
  createdAt: Date;
  updatedAt: Date;
}

const userSchema = new Schema<UserDoc>(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    // select:false so a stray `User.find()` can never leak hashes into a response.
    passwordHash: { type: String, required: true, select: false },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    role: { type: String, enum: ROLES, default: Role.User, required: true },
    isActive: { type: Boolean, default: true },
    tokenVersion: { type: Number, default: 0 },
  },
  {
    timestamps: true,
    collection: Collections.Users,
    toJSON: {
      transform: (_doc, ret: Record<string, unknown>) => {
        delete ret.passwordHash;
        delete ret.__v;
        return ret;
      },
    },
  },
);

// Admin/manager user listings filter by role and activity.
userSchema.index({ role: 1, isActive: 1 });

/*
 * Registered via the guard in models/registerModel.ts: re-importing this
 * module must not throw OverwriteModelError.
 */
export const User = registerModel<UserDoc>('User', userSchema);
