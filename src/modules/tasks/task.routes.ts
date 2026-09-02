import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { validate } from '../../middleware/validate.js';
import { writeLimiter } from '../../middleware/rateLimit.js';
import { requireManager } from '../../middleware/rbac.js';
import { commentRouter } from '../comments/comment.routes.js';
import {
  createTaskSchema,
  deleteTaskQuerySchema,
  idParams,
  listTasksQuerySchema,
  updateTaskSchema,
  userIdParams,
} from './task.schema.js';
import {
  createTaskHandler,
  deleteTaskHandler,
  getTaskHandler,
  listUserTasksHandler,
  taskHistoryHandler,
  taskInteractorsHandler,
  updateTaskHandler,
} from './task.controller.js';

export const taskRouter = Router();

// Everything below requires a valid access token.
taskRouter.use(authenticate);

/*
 * Route order matters: '/user/:userId' must be declared before '/:id' or
 * Express would match the literal 'user' segment as a task id.
 */
taskRouter.get(
  '/user/:userId',
  validate({ params: userIdParams, query: listTasksQuerySchema }),
  listUserTasksHandler,
);

taskRouter.post(
  '/',
  writeLimiter,
  requireManager, // only admins and managers create tasks
  validate({ body: createTaskSchema }),
  createTaskHandler,
);

taskRouter.get('/:id', validate({ params: idParams }), getTaskHandler);

taskRouter.put(
  '/:id',
  writeLimiter,
  validate({ params: idParams, body: updateTaskSchema }),
  updateTaskHandler,
);

taskRouter.delete(
  '/:id',
  writeLimiter,
  validate({ params: idParams, query: deleteTaskQuerySchema }),
  deleteTaskHandler,
);

// Aggregation-backed reads.
taskRouter.get('/:id/history', validate({ params: idParams }), taskHistoryHandler);
taskRouter.get('/:id/interactors', validate({ params: idParams }), taskInteractorsHandler);

// Comments are nested under a task.
taskRouter.use('/:id/comments', commentRouter);
