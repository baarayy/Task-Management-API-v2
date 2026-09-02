import { Router, type Request, type Response } from 'express';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { body, params, query, validate } from '../../middleware/validate.js';
import { writeLimiter } from '../../middleware/rateLimit.js';
import { UnauthorizedError } from '../../lib/errors.js';
import { idParams, objectId } from '../tasks/task.schema.js';
import type { Actor } from '../tasks/task.policy.js';
import { z } from 'zod';
import {
  createCommentSchema,
  listCommentsQuerySchema,
  type CreateCommentInput,
  type ListCommentsQuery,
} from './comment.schema.js';
import { addComment, deleteComment, listComments } from './comment.service.js';

// mergeParams so `:id` from the parent task router is visible here.
export const commentRouter = Router({ mergeParams: true });

function actorOf(req: Request): Actor {
  if (!req.user) throw new UnauthorizedError();
  return { id: req.user.id, role: req.user.role };
}

commentRouter.post(
  '/',
  writeLimiter,
  validate({ params: idParams, body: createCommentSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = params<{ id: string }>(req);
    const comment = await addComment(id, body<CreateCommentInput>(req), actorOf(req));
    res.status(201).json(comment);
  }),
);

commentRouter.get(
  '/',
  validate({ params: idParams, query: listCommentsQuerySchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = params<{ id: string }>(req);
    res.status(200).json(await listComments(id, query<ListCommentsQuery>(req), actorOf(req)));
  }),
);

commentRouter.delete(
  '/:commentId',
  writeLimiter,
  validate({ params: z.object({ id: objectId, commentId: objectId }) }),
  asyncHandler(async (req: Request, res: Response) => {
    const { id, commentId } = params<{ id: string; commentId: string }>(req);
    await deleteComment(id, commentId, actorOf(req));
    res.status(204).send();
  }),
);
