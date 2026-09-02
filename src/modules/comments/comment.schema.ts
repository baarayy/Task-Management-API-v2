import { z } from 'zod';
import { objectId } from '../tasks/task.schema.js';

export const createCommentSchema = z.object({
  body: z.string().min(1).max(5000),
  parentId: objectId.optional().nullable(),
  mentions: z.array(objectId).max(20).optional().default([]),
});

export const listCommentsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type CreateCommentInput = z.infer<typeof createCommentSchema>;
export type ListCommentsQuery = z.infer<typeof listCommentsQuerySchema>;
