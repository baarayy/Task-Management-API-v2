import type { NextFunction, Request, Response } from 'express';
import { ForbiddenError, UnauthorizedError } from '../lib/errors.js';
import { Role, type RoleType } from '../models/types.js';

/**
 * Coarse, route-level role gate. This is the *outer* layer only: it can say
 * "no user may call DELETE", but it cannot say "this manager may not touch
 * that particular task". Row-level rules live in the service layer (see
 * `task.policy.ts`) so a route that forgets this middleware still cannot be
 * used to read or mutate someone else's data.
 */
export function requireRole(...roles: RoleType[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) return next(new UnauthorizedError());
    if (!roles.includes(req.user.role)) {
      return next(
        new ForbiddenError(`This action requires one of the following roles: ${roles.join(', ')}`),
      );
    }
    next();
  };
}

export const requireAdmin = requireRole(Role.Admin);
export const requireManager = requireRole(Role.Admin, Role.Manager);
