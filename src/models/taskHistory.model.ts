import { Schema, type Document, type Types } from 'mongoose';
import { registerModel } from './registerModel.js';
import { Collections, HISTORY_ACTIONS, type HistoryActionType } from './types.js';

/**
 * Append-only audit log. Nothing in the application ever updates or deletes a
 * history document; that immutability is what makes it usable as evidence.
 */
export interface TaskHistoryDoc extends Document<Types.ObjectId> {
  _id: Types.ObjectId;
  taskId: Types.ObjectId;
  actorId: Types.ObjectId;
  action: HistoryActionType;
  field?: string;
  oldValue?: unknown;
  newValue?: unknown;
  metadata?: Record<string, unknown>;
  createdAt: Date;
}

const taskHistorySchema = new Schema<TaskHistoryDoc>(
  {
    taskId: { type: Schema.Types.ObjectId, ref: 'Task', required: true },
    actorId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    action: { type: String, enum: HISTORY_ACTIONS, required: true },
    field: { type: String },
    oldValue: { type: Schema.Types.Mixed },
    newValue: { type: Schema.Types.Mixed },
    metadata: { type: Schema.Types.Mixed },
  },
  {
    // Only createdAt: an audit entry that can be "updated" is not an audit entry.
    timestamps: { createdAt: true, updatedAt: false },
    collection: Collections.TaskHistory,
  },
);

// Timeline reads: newest first for one task.
taskHistorySchema.index({ taskId: 1, createdAt: -1 });
// "who touched this task" and per-user activity feeds.
taskHistorySchema.index({ actorId: 1, createdAt: -1 });
// Filtered timelines, e.g. status changes only.
taskHistorySchema.index({ taskId: 1, action: 1, createdAt: -1 });

/*
 * Registered via the guard in models/registerModel.ts: re-importing this
 * module must not throw OverwriteModelError.
 */
export const TaskHistory = registerModel<TaskHistoryDoc>('TaskHistory', taskHistorySchema);
