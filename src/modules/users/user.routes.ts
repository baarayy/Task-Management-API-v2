import { Router, type Request, type Response } from 'express';
import argon2 from 'argon2';
import { z } from 'zod';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { body, params, query, validate } from '../../middleware/validate.js';
import { authenticate } from '../../middleware/authenticate.js';
import { requireAdmin, requireManager } from '../../middleware/rbac.js';
import { ConflictError, NotFoundError } from '../../lib/errors.js';
import { ROLES, Role, User } from '../../models/index.js';
import { revokeAllForUser } from '../auth/token.service.js';
import { objectId } from '../tasks/task.schema.js';

export const userRouter = Router();
userRouter.use(authenticate);

const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  role: z.enum(ROLES as [string, ...string[]]).optional(),
  q: z.string().min(1).max(120).optional(),
});

/** Managers need the roster to assign work; plain users do not. */
userRouter.get(
  '/',
  requireManager,
  validate({ query: listQuery }),
  asyncHandler(async (req: Request, res: Response) => {
    const q = query<z.infer<typeof listQuery>>(req);
    const filter: Record<string, unknown> = { isActive: true };
    if (q.role) filter.role = q.role;
    if (q.q) filter.$or = [{ name: new RegExp(q.q, 'i') }, { email: new RegExp(q.q, 'i') }];

    const skip = (q.page - 1) * q.limit;
    const [data, total] = await Promise.all([
      User.find(filter).sort({ name: 1 }).skip(skip).limit(q.limit).lean(),
      User.countDocuments(filter),
    ]);

    res.status(200).json({
      data,
      meta: { page: q.page, limit: q.limit, total, totalPages: Math.ceil(total / q.limit) },
    });
  }),
);

const createUserSchema = z.object({
  email: z.string().email().max(254).toLowerCase(),
  password: z.string().min(10).max(128),
  name: z.string().min(1).max(120),
  role: z.enum(ROLES as [string, ...string[]]).default(Role.User),
});

/**
 * The only path that can mint a privileged account. Public /auth/register is
 * hard-locked to the `user` role.
 */
userRouter.post(
  '/',
  requireAdmin,
  validate({ body: createUserSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const input = body<z.infer<typeof createUserSchema>>(req);
    if (await User.exists({ email: input.email })) {
      throw new ConflictError('An account with that email already exists');
    }
    const user = await User.create({
      email: input.email,
      name: input.name,
      role: input.role,
      passwordHash: await argon2.hash(input.password, { type: argon2.argon2id }),
    });
    res.status(201).json(user);
  }),
);

const patchUserSchema = z
  .object({
    role: z.enum(ROLES as [string, ...string[]]).optional(),
    isActive: z.boolean().optional(),
    name: z.string().min(1).max(120).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'At least one field must be provided');

userRouter.patch(
  '/:id',
  requireAdmin,
  validate({ params: z.object({ id: objectId }), body: patchUserSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = params<{ id: string }>(req);
    const input = body<z.infer<typeof patchUserSchema>>(req);

    const user = await User.findById(id);
    if (!user) throw new NotFoundError('User not found');

    // A privilege change or a deactivation must not leave live sessions behind:
    // bumping tokenVersion invalidates every access token already issued.
    const securitySensitive =
      (input.role !== undefined && input.role !== user.role) ||
      (input.isActive !== undefined && input.isActive !== user.isActive);

    Object.assign(user, input);
    if (securitySensitive) user.tokenVersion += 1;
    await user.save();
    if (securitySensitive) await revokeAllForUser(user._id.toString());

    res.status(200).json(user);
  }),
);
