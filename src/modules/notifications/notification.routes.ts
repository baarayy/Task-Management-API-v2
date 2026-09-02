import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { Types } from 'mongoose';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { params, query, validate } from '../../middleware/validate.js';
import { authenticate } from '../../middleware/authenticate.js';
import { NotFoundError, UnauthorizedError } from '../../lib/errors.js';
import { Notification } from '../../models/notification.model.js';
import { objectId } from '../tasks/task.schema.js';

export const notificationRouter = Router();
notificationRouter.use(authenticate);

const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  unreadOnly: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

/** A user only ever sees their own inbox - the filter is not client-supplied. */
notificationRouter.get(
  '/',
  validate({ query: listQuery }),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw new UnauthorizedError();
    const q = query<z.infer<typeof listQuery>>(req);

    const filter: Record<string, unknown> = { userId: new Types.ObjectId(req.user.id) };
    if (q.unreadOnly) filter.readAt = null;

    const skip = (q.page - 1) * q.limit;
    const [data, total, unread] = await Promise.all([
      Notification.find(filter).sort({ createdAt: -1 }).skip(skip).limit(q.limit).lean(),
      Notification.countDocuments(filter),
      Notification.countDocuments({ userId: new Types.ObjectId(req.user.id), readAt: null }),
    ]);

    res.status(200).json({
      data,
      meta: { page: q.page, limit: q.limit, total, totalPages: Math.ceil(total / q.limit), unread },
    });
  }),
);

notificationRouter.patch(
  '/:id/read',
  validate({ params: z.object({ id: objectId }) }),
  asyncHandler(async (req: Request, res: Response) => {
    if (!req.user) throw new UnauthorizedError();
    const { id } = params<{ id: string }>(req);
    const now = new Date();

    const notification = await Notification.findOneAndUpdate(
      { _id: id, userId: new Types.ObjectId(req.user.id), readAt: null },
      // Setting expiresAt arms the TTL index: read notifications are reaped
      // after 30 days, unread ones are kept indefinitely.
      { $set: { readAt: now, expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000) } },
      { new: true },
    );

    if (!notification) throw new NotFoundError('Notification not found or already read');
    res.status(200).json(notification);
  }),
);
