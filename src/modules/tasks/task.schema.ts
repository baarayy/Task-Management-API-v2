import { z } from 'zod';
import { TASK_PRIORITIES, TASK_STATUSES } from '../../models/types.js';

export const objectId = z
  .string()
  .regex(/^[0-9a-fA-F]{24}$/, 'Must be a valid 24-character ObjectId');

export const idParams = z.object({ id: objectId });
export const userIdParams = z.object({ userId: objectId });

const status = z.enum(TASK_STATUSES as [string, ...string[]]);
const priority = z.enum(TASK_PRIORITIES as [string, ...string[]]);

export const createTaskSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(5000).optional(),
  status: status.optional(),
  priority: priority.optional(),
  dueDate: z.coerce.date().optional().nullable(),
  assignees: z.array(objectId).max(50).optional().default([]),
  tags: z.array(z.string().min(1).max(40)).max(20).optional().default([]),
});

// At least one field required, otherwise a PUT is a no-op that still bumps the
// audit log and busts the cache.
export const updateTaskSchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
    description: z.string().max(5000).optional(),
    status: status.optional(),
    priority: priority.optional(),
    dueDate: z.coerce.date().optional().nullable(),
    assignees: z.array(objectId).max(50).optional(),
    tags: z.array(z.string().min(1).max(40)).max(20).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'At least one field must be provided');

/**
 * Query contract for GET /tasks/user/:userId.
 * Everything is coerced and bounded here so the service can trust its input:
 * `limit` is capped at 100 so a client cannot ask for the whole collection.
 */
export const listTasksQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z
    .union([status, z.array(status)])
    .optional()
    .transform((v) => (v === undefined ? undefined : Array.isArray(v) ? v : [v])),
  priority: z
    .union([priority, z.array(priority)])
    .optional()
    .transform((v) => (v === undefined ? undefined : Array.isArray(v) ? v : [v])),
  dueBefore: z.coerce.date().optional(),
  dueAfter: z.coerce.date().optional(),
  tags: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((v) => (v === undefined ? undefined : Array.isArray(v) ? v : v.split(','))),
  q: z.string().min(1).max(120).optional(),
  // Whitelisted sort fields only - an arbitrary field would sort off-index.
  sortBy: z.enum(['dueDate', 'createdAt', 'updatedAt', 'priority', 'status']).default('dueDate'),
  sortOrder: z.enum(['asc', 'desc']).default('asc'),
  includeDeleted: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

export const deleteTaskQuerySchema = z.object({
  hard: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

export type CreateTaskInput = z.infer<typeof createTaskSchema>;
export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;
export type ListTasksQuery = z.infer<typeof listTasksQuerySchema>;
export type DeleteTaskQuery = z.infer<typeof deleteTaskQuerySchema>;
