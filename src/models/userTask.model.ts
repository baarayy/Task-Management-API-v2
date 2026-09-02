import { Schema, type Document, type Types } from 'mongoose';
import { registerModel } from './registerModel.js';
import { ASSIGNMENT_ROLES, AssignmentRole, Collections, type AssignmentRoleType } from './types.js';

/**
 * Explicit many-to-many join between users and tasks.
 *
 * Why keep this *and* `tasks.assignees`? They answer different questions.
 * This collection carries assignment metadata - who assigned whom, in what
 * capacity, when - which an embedded array of ids cannot express, and it is
 * the natural place to grow per-assignment fields (accepted_at, estimate).
 * The embedded array exists purely as a read optimisation. See docs/SCHEMA.md.
 */
export interface UserTaskDoc extends Document<Types.ObjectId> {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  taskId: Types.ObjectId;
  role: AssignmentRoleType;
  assignedBy: Types.ObjectId;
  assignedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const userTaskSchema = new Schema<UserTaskDoc>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    taskId: { type: Schema.Types.ObjectId, ref: 'Task', required: true },
    role: { type: String, enum: ASSIGNMENT_ROLES, default: AssignmentRole.Assignee },
    assignedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    assignedAt: { type: Date, default: Date.now },
  },
  { timestamps: true, collection: Collections.UserTasks },
);

// A user holds at most one assignment role per task - enforced by the database,
// not just by application logic, so concurrent assigns cannot duplicate.
userTaskSchema.index({ userId: 1, taskId: 1 }, { unique: true });
// "who is on this task, in what capacity"
userTaskSchema.index({ taskId: 1, role: 1 });
// "what is this user assigned to, most recent first"
userTaskSchema.index({ userId: 1, assignedAt: -1 });

/*
 * Registered via the guard in models/registerModel.ts: re-importing this
 * module must not throw OverwriteModelError.
 */
export const UserTask = registerModel<UserTaskDoc>('UserTask', userTaskSchema);
