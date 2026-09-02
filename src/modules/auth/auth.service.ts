import argon2 from 'argon2';
import { ConflictError, ForbiddenError, UnauthorizedError } from '../../lib/errors.js';
import { User } from '../../models/user.model.js';
import { Role, type RoleType } from '../../models/types.js';
import {
  consumeRefreshToken,
  issueRefreshToken,
  revokeAllForUser,
  revokeFamily,
  signAccessToken,
  verifyRefreshSignature,
} from './token.service.js';
import type { LoginInput, RegisterInput } from './auth.schema.js';

/**
 * Argon2id with deliberately chosen parameters (~64MB, 3 passes). Argon2 is
 * memory-hard, which is what makes GPU cracking expensive - the reason to
 * prefer it over bcrypt for new systems.
 */
const ARGON_OPTS = {
  type: argon2.argon2id,
  memoryCost: 2 ** 16,
  timeCost: 3,
  parallelism: 1,
} as const;

export interface AuthResult {
  user: { id: string; email: string; name: string; role: RoleType };
  accessToken: string;
  refreshToken: string;
}

export async function register(input: RegisterInput): Promise<AuthResult> {
  const existing = await User.findOne({ email: input.email }).lean();
  if (existing) throw new ConflictError('An account with that email already exists');

  // Defence in depth: the schema defaults role to `user`, and this rejects any
  // attempt to smuggle a privileged role through the public endpoint.
  if (input.role && input.role !== Role.User) {
    throw new ForbiddenError('Privileged accounts can only be created by an administrator');
  }

  const passwordHash = await argon2.hash(input.password, ARGON_OPTS);
  const user = await User.create({
    email: input.email,
    passwordHash,
    name: input.name,
    role: Role.User,
  });

  return buildAuthResult(user._id.toString(), user.email, user.name, user.role, user.tokenVersion);
}

export async function login(input: LoginInput): Promise<AuthResult> {
  const user = await User.findOne({ email: input.email }).select('+passwordHash');

  /*
   * Constant-ish work on both branches. If we returned early on "no such user"
   * the response time would differ measurably from the wrong-password case,
   * letting an attacker enumerate valid accounts. Verifying against a dummy
   * hash keeps the two paths comparable, and the error message is identical.
   */
  if (!user) {
    await argon2.hash(input.password, ARGON_OPTS).catch(() => undefined);
    throw new UnauthorizedError('Invalid email or password');
  }

  const valid = await argon2.verify(user.passwordHash, input.password).catch(() => false);
  if (!valid) throw new UnauthorizedError('Invalid email or password');
  if (!user.isActive) throw new UnauthorizedError('Account is deactivated');

  return buildAuthResult(user._id.toString(), user.email, user.name, user.role, user.tokenVersion);
}

/** Rotates the refresh token; reuse detection lives in `consumeRefreshToken`. */
export async function refresh(token: string): Promise<AuthResult> {
  const payload = await consumeRefreshToken(token);

  const user = await User.findById(payload.sub);
  if (!user || !user.isActive) throw new UnauthorizedError('Account is no longer active');
  if (user.tokenVersion !== payload.tokenVersion) {
    throw new UnauthorizedError('Session has been revoked; please sign in again');
  }

  // The new token stays in the same family, so a later replay of any token in
  // the chain still invalidates the whole lineage.
  const refreshToken = await issueRefreshToken(
    user._id.toString(),
    user.tokenVersion,
    payload.family,
  );

  return {
    user: { id: user._id.toString(), email: user.email, name: user.name, role: user.role },
    accessToken: signAccessToken({
      sub: user._id.toString(),
      email: user.email,
      role: user.role,
      tokenVersion: user.tokenVersion,
    }),
    refreshToken: refreshToken.token,
  };
}

/** Logs out one session. `allDevices` bumps tokenVersion, killing every session. */
export async function logout(
  userId: string,
  refreshToken?: string,
  allDevices = false,
): Promise<void> {
  if (allDevices) {
    await User.updateOne({ _id: userId }, { $inc: { tokenVersion: 1 } });
    await revokeAllForUser(userId);
    return;
  }

  if (refreshToken) {
    try {
      const payload = verifyRefreshSignature(refreshToken);
      if (payload.sub === userId) await revokeFamily(userId, payload.family);
    } catch {
      // An expired or malformed token on logout is not worth a 401 - the
      // caller's intent (end this session) is already satisfied.
    }
  }
}

async function buildAuthResult(
  id: string,
  email: string,
  name: string,
  role: RoleType,
  tokenVersion: number,
): Promise<AuthResult> {
  const { token } = await issueRefreshToken(id, tokenVersion);
  return {
    user: { id, email, name, role },
    accessToken: signAccessToken({ sub: id, email, role, tokenVersion }),
    refreshToken: token,
  };
}
