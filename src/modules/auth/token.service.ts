import { createHash, randomUUID } from 'node:crypto';
import jwt, { type SignOptions } from 'jsonwebtoken';
import { env } from '../../config/env.js';
import { getRedis } from '../../lib/redis.js';
import { UnauthorizedError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import type { RoleType } from '../../models/types.js';

export interface AccessPayload {
  sub: string;
  email: string;
  role: RoleType;
  tokenVersion: number;
}

export interface RefreshPayload {
  sub: string;
  jti: string;
  family: string;
  tokenVersion: number;
}

const refreshKey = (userId: string, jti: string) => `refresh:${userId}:${jti}`;
const familyKey = (userId: string, family: string) => `refresh:family:${userId}:${family}`;

/** Tokens are stored hashed - a Redis dump must not yield usable credentials. */
const hash = (token: string) => createHash('sha256').update(token).digest('hex');

export function signAccessToken(payload: AccessPayload): string {
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, {
    expiresIn: env.JWT_ACCESS_TTL,
    algorithm: 'HS256',
  } as SignOptions);
}

export function verifyAccessToken(token: string): AccessPayload {
  try {
    return jwt.verify(token, env.JWT_ACCESS_SECRET, { algorithms: ['HS256'] }) as AccessPayload;
  } catch (err) {
    const message =
      err instanceof jwt.TokenExpiredError ? 'Access token expired' : 'Invalid access token';
    throw new UnauthorizedError(message);
  }
}

/**
 * Issues a refresh token and records its hash in Redis.
 *
 * Statelessness is the wrong trade for refresh tokens: without server-side
 * state, a stolen refresh token stays valid for its full lifetime and logout
 * is a lie. Storing the hash makes revocation real.
 */
export async function issueRefreshToken(
  userId: string,
  tokenVersion: number,
  family: string = randomUUID(),
): Promise<{ token: string; jti: string; family: string }> {
  const jti = randomUUID();
  const token = jwt.sign({ sub: userId, jti, family, tokenVersion }, env.JWT_REFRESH_SECRET, {
    expiresIn: env.JWT_REFRESH_TTL,
    algorithm: 'HS256',
  } as SignOptions);

  const redis = getRedis();
  await redis
    .multi()
    .set(refreshKey(userId, jti), hash(token), 'EX', env.JWT_REFRESH_TTL_SECONDS)
    .sadd(familyKey(userId, family), jti)
    .expire(familyKey(userId, family), env.JWT_REFRESH_TTL_SECONDS)
    .exec();

  return { token, jti, family };
}

export function verifyRefreshSignature(token: string): RefreshPayload {
  try {
    return jwt.verify(token, env.JWT_REFRESH_SECRET, { algorithms: ['HS256'] }) as RefreshPayload;
  } catch {
    throw new UnauthorizedError('Invalid or expired refresh token');
  }
}

/**
 * Consumes a refresh token as part of rotation.
 *
 * If the token verifies but is not in Redis, it has already been used - which
 * means either a replay or a stolen token being used in parallel with the
 * legitimate one. We cannot tell which, so we revoke the entire family and
 * force a fresh login. This is the standard refresh-token reuse detection.
 */
export async function consumeRefreshToken(token: string): Promise<RefreshPayload> {
  const payload = verifyRefreshSignature(token);
  const redis = getRedis();
  const key = refreshKey(payload.sub, payload.jti);
  const stored = await redis.get(key);

  if (!stored || stored !== hash(token)) {
    logger.warn({ userId: payload.sub, family: payload.family }, 'Refresh token reuse detected');
    await revokeFamily(payload.sub, payload.family);
    throw new UnauthorizedError('Refresh token has already been used; please sign in again');
  }

  await redis.del(key);
  await redis.srem(familyKey(payload.sub, payload.family), payload.jti);
  return payload;
}

export async function revokeFamily(userId: string, family: string): Promise<void> {
  const redis = getRedis();
  const jtis = await redis.smembers(familyKey(userId, family));
  if (jtis.length > 0) await redis.del(...jtis.map((jti) => refreshKey(userId, jti)));
  await redis.del(familyKey(userId, family));
}

export async function revokeAllForUser(userId: string): Promise<void> {
  const redis = getRedis();
  // Bounded by one user's live sessions, and only on explicit logout-all.
  const stream = redis.scanStream({ match: `refresh:*${userId}*`, count: 100 });
  for await (const keys of stream) {
    if ((keys as string[]).length > 0) await redis.del(...(keys as string[]));
  }
}
