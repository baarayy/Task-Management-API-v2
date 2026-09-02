import { Schema, type Document, type Types } from 'mongoose';
import { registerModel } from './registerModel.js';
import { Collections } from './types.js';

export interface TaskCommentDoc extends Document<Types.ObjectId> {
  _id: Types.ObjectId;
  taskId: Types.ObjectId;
  authorId: Types.ObjectId;
  body: string;
  /** Parent comment for one level of threading; null for a root comment. */
  parentId?: Types.ObjectId | null;
  mentions: Types.ObjectId[];
  deletedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const taskCommentSchema = new Schema<TaskCommentDoc>(
  {
    taskId: { type: Schema.Types.ObjectId, ref: 'Task', required: true },
    authorId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    body: { type: String, required: true, trim: true, maxlength: 5000 },
    parentId: { type: Schema.Types.ObjectId, ref: 'TaskComment', default: null },
    mentions: [{ type: Schema.Types.ObjectId, ref: 'User' }],
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: Collections.TaskComments },
);

// Comment thread for a task, newest first.
taskCommentSchema.index({ taskId: 1, deletedAt: 1, createdAt: -1 });
// Replies to a given comment.
taskCommentSchema.index({ parentId: 1, createdAt: 1 });
// "users who commented on this task" - feeds the interactors aggregation.
taskCommentSchema.index({ authorId: 1, taskId: 1 });

/*
 * Registered via the guard in models/registerModel.ts: re-importing this
 * module must not throw OverwriteModelError.
 */
export const TaskComment = registerModel<TaskCommentDoc>('TaskComment', taskCommentSchema);
