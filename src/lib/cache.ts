import { createHash } from 'node:crypto';
import { env } from '../config/env.js';
import { getRedis } from './redis.js';
import { logger } from './logger.js';

/**
 * Tag-based cache invalidation.
 *
 * A user's task list can be invalidated by a write performed by a *different*
 * user (a manager reassigning a task, a colleague commenting). Scanning Redis
 * for `tasks:user:{id}:*` on every write means KEYS/SCAN on a hot path, which
 * degrades badly as the keyspace grows.
 *
 * Instead each cached key is registered in a per-user tag set. Invalidation is
 * then: read the set, delete its members, delete the set - all O(n) in the
 * number of live entries for that one user, never in the size of the keyspace.
 */

const TAG_PREFIX = 'cache:tag:user:';

export function userTasksKey(userId: string, query: Record<string, unknown>): string {
  // Sort keys so that ?status=todo&page=1 and ?page=1&status=todo share a slot.
  const canonical = JSON.stringify(
    Object.keys(query)
      .filter((k) => query[k] !== undefined)
      .sort()
      .map((k) => [k, query[k]]),
  );
  const hash = createHash('sha1').update(canonical).digest('hex').slice(0, 16);
  return `tasks:user:${userId}:${hash}`;
}

export function userTag(userId: string): string {
  return `${TAG_PREFIX}${userId}`;
}

/** Read-through cache. Redis failures degrade to a cache miss, never a 500. */
export async function cached<T>(
  key: string,
  tags: string[],
  ttlSeconds: number,
  producer: () => Promise<T>,
): Promise<{ value: T; hit: boolean }> {
  const redis = getRedis();

  try {
    const raw = await redis.get(key);
    if (raw) return { value: JSON.parse(raw) as T, hit: true };
  } catch (err) {
    logger.warn({ err, key }, 'Cache read failed, falling through to source');
  }

  const value = await producer();

  try {
    const pipeline = redis.pipeline();
    pipeline.set(key, JSON.stringify(value), 'EX', ttlSeconds);
    for (const tag of tags) {
      pipeline.sadd(tag, key);
      // Tag sets outlive their members slightly; the TTL stops them leaking.
      pipeline.expire(tag, ttlSeconds * 2);
    }
    await pipeline.exec();
  } catch (err) {
    logger.warn({ err, key }, 'Cache write failed');
  }

  return { value, hit: false };
}

/** Invalidate every cached entry tagged for the given users. */
export async function invalidateUsers(userIds: Array<string | undefined | null>): Promise<void> {
  const ids = [...new Set(userIds.filter((id): id is string => Boolean(id)))];
  if (ids.length === 0) return;

  const redis = getRedis();
  try {
    for (const id of ids) {
      const tag = userTag(id);
      const keys = await redis.smembers(tag);
      if (keys.length > 0) await redis.del(...keys);
      await redis.del(tag);
    }
    logger.debug({ users: ids }, 'Cache invalidated');
  } catch (err) {
    // A failed invalidation is a staleness bug, not a request failure - the
    // TTL bounds the damage. Log loudly so it is visible in monitoring.
    logger.error({ err, users: ids }, 'Cache invalidation failed');
  }
}

export const CACHE_TTL = env.CACHE_TTL_SECONDS;
