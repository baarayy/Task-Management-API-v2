import type { NextFunction, Request, Response } from 'express';
import { UnauthorizedError } from '../lib/errors.js';
import { verifyAccessToken } from '../modules/auth/token.service.js';
import { User } from '../models/user.model.js';

/**
 * Verifies the bearer token and confirms the account is still usable.
 *
 * The extra User lookup is deliberate: a purely stateless check would keep
 * honouring tokens for deactivated users and for sessions the user has since
 * revoked. `tokenVersion` is the cheap invalidation lever - bumping it on the
 * user document instantly kills every token issued before the bump.
 */
export async function authenticate(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedError('Missing or malformed Authorization header');
    }

    const payload = verifyAccessToken(header.slice(7).trim());
    const user = await User.findById(payload.sub).select('email role isActive tokenVersion').lean();

    if (!user) throw new UnauthorizedError('User no longer exists');
    if (!user.isActive) throw new UnauthorizedError('Account is deactivated');
    if (user.tokenVersion !== payload.tokenVersion) {
      throw new UnauthorizedError('Session has been revoked; please sign in again');
    }

    req.user = { id: String(user._id), role: user.role, email: user.email };
    next();
  } catch (err) {
    next(err);
  }
}
