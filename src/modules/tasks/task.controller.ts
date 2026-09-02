import type { Request, Response } from 'express';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { body, params, query } from '../../middleware/validate.js';
import { UnauthorizedError } from '../../lib/errors.js';
import type { Actor } from './task.policy.js';
import * as taskService from './task.service.js';
import type {
  CreateTaskInput,
  DeleteTaskQuery,
  ListTasksQuery,
  UpdateTaskInput,
} from './task.schema.js';

function actorOf(req: Request): Actor {
  if (!req.user) throw new UnauthorizedError();
  return { id: req.user.id, role: req.user.role };
}

export const createTaskHandler = asyncHandler(async (req: Request, res: Response) => {
  const task = await taskService.createTask(body<CreateTaskInput>(req), actorOf(req));
  res.status(201).json(task);
});

export const getTaskHandler = asyncHandler(async (req: Request, res: Response) => {
  const { id } = params<{ id: string }>(req);
  res.status(200).json(await taskService.getTaskById(id, actorOf(req)));
});

export const updateTaskHandler = asyncHandler(async (req: Request, res: Response) => {
  const { id } = params<{ id: string }>(req);
  const task = await taskService.updateTask(id, body<UpdateTaskInput>(req), actorOf(req));
  res.status(200).json(task);
});

export const deleteTaskHandler = asyncHandler(async (req: Request, res: Response) => {
  const { id } = params<{ id: string }>(req);
  const { hard } = query<DeleteTaskQuery>(req);
  await taskService.deleteTask(id, actorOf(req), hard);
  res.status(204).send();
});

export const listUserTasksHandler = asyncHandler(async (req: Request, res: Response) => {
  const { userId } = params<{ userId: string }>(req);
  const { result, cacheHit } = await taskService.listUserTasks(
    userId,
    query<ListTasksQuery>(req),
    actorOf(req),
  );
  // Makes the cache observable from the outside - useful in the demo and for
  // spotting invalidation bugs in staging.
  res.setHeader('X-Cache', cacheHit ? 'HIT' : 'MISS');
  res.status(200).json(result);
});

export const taskHistoryHandler = asyncHandler(async (req: Request, res: Response) => {
  const { id } = params<{ id: string }>(req);
  res.status(200).json(await taskService.taskHistory(id, actorOf(req)));
});

export const taskInteractorsHandler = asyncHandler(async (req: Request, res: Response) => {
  const { id } = params<{ id: string }>(req);
  res.status(200).json({ data: await taskService.taskInteractors(id, actorOf(req)) });
});
