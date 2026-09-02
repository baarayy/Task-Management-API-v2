import { Schema, type Document, type Types } from 'mongoose';
import { registerModel } from './registerModel.js';
import { Collections, NOTIFICATION_TYPES, type NotificationTypeType } from './types.js';

export interface NotificationDoc extends Document<Types.ObjectId> {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  type: NotificationTypeType;
  taskId?: Types.ObjectId | null;
  actorId?: Types.ObjectId | null;
  title: string;
  payload?: Record<string, unknown>;
  readAt?: Date | null;
  /** Set when the notification is read; a TTL index reaps it 30 days later. */
  expiresAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const notificationSchema = new Schema<NotificationDoc>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, enum: NOTIFICATION_TYPES, required: true },
    taskId: { type: Schema.Types.ObjectId, ref: 'Task', default: null },
    actorId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    title: { type: String, required: true, maxlength: 300 },
    payload: { type: Schema.Types.Mixed },
    readAt: { type: Date, default: null },
    expiresAt: { type: Date, default: null },
  },
  { timestamps: true, collection: Collections.Notifications },
);

// The inbox query: unread first, newest first, for one user.
notificationSchema.index({ userId: 1, readAt: 1, createdAt: -1 });
// Notifications attached to a task - part of the unified task timeline.
notificationSchema.index({ taskId: 1, createdAt: -1 });
/*
 * TTL index. `expiresAt` is only populated when a notification is marked read,
 * so unread notifications are never reaped - a partial-expiry pattern that
 * keeps the collection bounded without losing anything the user has not seen.
 */
notificationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

/*
 * Registered via the guard in models/registerModel.ts: re-importing this
 * module must not throw OverwriteModelError.
 */
export const Notification = registerModel<NotificationDoc>('Notification', notificationSchema);
