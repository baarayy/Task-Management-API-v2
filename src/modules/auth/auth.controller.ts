import type { Request, Response } from 'express';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { body } from '../../middleware/validate.js';
import { User } from '../../models/user.model.js';
import { NotFoundError, UnauthorizedError } from '../../lib/errors.js';
import * as authService from './auth.service.js';
import type { LoginInput, RefreshInput, RegisterInput } from './auth.schema.js';

export const registerHandler = asyncHandler(async (req: Request, res: Response) => {
  const result = await authService.register(body<RegisterInput>(req));
  res.status(201).json(result);
});

export const loginHandler = asyncHandler(async (req: Request, res: Response) => {
  const result = await authService.login(body<LoginInput>(req));
  res.status(200).json(result);
});

export const refreshHandler = asyncHandler(async (req: Request, res: Response) => {
  const result = await authService.refresh(body<RefreshInput>(req).refreshToken);
  res.status(200).json(result);
});

export const logoutHandler = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new UnauthorizedError();
  const payload = (req.body ?? {}) as { refreshToken?: string; allDevices?: boolean };
  await authService.logout(req.user.id, payload.refreshToken, payload.allDevices === true);
  res.status(204).send();
});

export const meHandler = asyncHandler(async (req: Request, res: Response) => {
  if (!req.user) throw new UnauthorizedError();
  const user = await User.findById(req.user.id).lean();
  if (!user) throw new NotFoundError('User not found');
  res.status(200).json({
    id: String(user._id),
    email: user.email,
    name: user.name,
    role: user.role,
    isActive: user.isActive,
    createdAt: user.createdAt,
  });
});
