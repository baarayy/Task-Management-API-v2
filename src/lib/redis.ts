import { Redis } from 'ioredis';
import { env } from '../config/env.js';
import { logger } from './logger.js';

let client: Redis | null = null;

/**
 * Single shared connection for cache + rate limiting.
 * BullMQ gets its own connections (it requires maxRetriesPerRequest: null and
 * holds blocking connections, which must not be shared with request-path work).
 */
export function getRedis(): Redis {
  if (client) return client;
  client = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: 3,
    enableOfflineQueue: true,
    lazyConnect: false,
    retryStrategy: (times) => Math.min(times * 200, 5_000),
  });
  client.on('error', (err) => logger.error({ err }, 'Redis error'));
  client.on('connect', () => logger.info('Redis connected'));
  return client;
}

export function createBullConnection(): Redis {
  return new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
}

export async function closeRedis(): Promise<void> {
  if (client) {
    await client.quit().catch(() => client?.disconnect());
    client = null;
  }
}
