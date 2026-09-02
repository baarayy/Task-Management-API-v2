import { Schema, type Document, type Types } from 'mongoose';
import { registerModel } from './registerModel.js';
import {
  Collections,
  TASK_PRIORITIES,
  TASK_STATUSES,
  TaskPriority,
  TaskStatus,
  type TaskPriorityType,
  type TaskStatusType,
} from './types.js';

export interface TaskDoc extends Document<Types.ObjectId> {
  _id: Types.ObjectId;
  title: string;
  description?: string;
  status: TaskStatusType;
  priority: TaskPriorityType;
  dueDate?: Date | null;
  createdBy: Types.ObjectId;
  /**
   * Denormalised copy of the assignee ids also held in `user_tasks`.
   * Lets the hottest query (a user's task list) be served by one multikey
   * index scan instead of a join. `user_tasks` remains the source of truth
   * for assignment *metadata*; the two are written together in the service.
   */
  assignees: Types.ObjectId[];
  tags: string[];
  deletedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const taskSchema = new Schema<TaskDoc>(
  {
    title: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, trim: true, maxlength: 5000 },
    status: { type: String, enum: TASK_STATUSES, default: TaskStatus.Todo, required: true },
    priority: {
      type: String,
      enum: TASK_PRIORITIES,
      default: TaskPriority.Medium,
      required: true,
    },
    dueDate: { type: Date, default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    assignees: [{ type: Schema.Types.ObjectId, ref: 'User' }],
    tags: [{ type: String, trim: true, lowercase: true, maxlength: 40 }],
    // Soft delete: history and comments stay meaningful after a task is removed.
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: Collections.Tasks },
);

/*
 * Indexing strategy - each index is justified by a specific query:
 *
 * 1. { assignees, deletedAt, status, dueDate }
 *    The primary driver of GET /tasks/user/:userId. Multikey on `assignees`,
 *    then equality on deletedAt/status, then range+sort on dueDate - ESR
 *    (Equality, Sort, Range) ordering so the sort is satisfied by the index
 *    and Mongo never has to do an in-memory SORT stage.
 * 2. { createdBy, deletedAt, status }
 *    "tasks I created" listings and manager dashboards.
 * 3. { status, dueDate }
 *    Cross-user reporting and the due-soon notification sweep.
 * 4. text index
 *    Free-text ?q= search over title/description, title weighted higher.
 */
taskSchema.index({ assignees: 1, deletedAt: 1, status: 1, dueDate: 1 });
taskSchema.index({ createdBy: 1, deletedAt: 1, status: 1 });
taskSchema.index({ status: 1, dueDate: 1 });
taskSchema.index({ tags: 1 });
taskSchema.index(
  { title: 'text', description: 'text' },
  { weights: { title: 10, description: 3 }, name: 'task_text_search' },
);

/*
 * Registered via the guard in models/registerModel.ts: re-importing this
 * module must not throw OverwriteModelError.
 */
export const Task = registerModel<TaskDoc>('Task', taskSchema);
