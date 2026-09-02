import rateLimit, { type Options } from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import type { Request, Response } from 'express';
import { env, isTest } from '../config/env.js';
import { getRedis } from '../lib/redis.js';
import { logger } from '../lib/logger.js';

/**
 * Limits are backed by Redis, not memory: with more than one API container an
 * in-memory counter lets an attacker get N times the allowance by spreading
 * requests across instances.
 */
function store(prefix: string) {
  if (isTest) return undefined; // in-memory in tests; no Redis dependency
  const redis = getRedis();
  return new RedisStore({
    prefix: `rl:${prefix}:`,
    sendCommand: (...args: string[]) => redis.call(...(args as [string, ...string[]])) as never,
  });
}

const base = (prefix: string, windowMs: number, max: number): Partial<Options> => ({
  windowMs,
  max,
  // Limiters are module-level singletons, so their counters would otherwise
  // bleed between test cases. Limiter behaviour itself is covered explicitly
  // in tests/integration/rateLimit.test.ts against a purpose-built app.
  skip: () => isTest,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  store: store(prefix),
  handler: (req: Request, res: Response) => {
    logger.warn({ ip: req.ip, path: req.path }, 'Rate limit exceeded');
    res.status(429).json({
      error: { code: 'TOO_MANY_REQUESTS', message: 'Too many requests, please try again later' },
    });
  },
});

/** Broad protection for every route. */
export const globalLimiter = rateLimit(base('global', 15 * 60_000, env.RATE_LIMIT_GLOBAL_MAX));

/**
 * Credential endpoints, keyed by IP *and* submitted email so one attacker
 * cannot lock out a victim by burning that account's allowance from many IPs,
 * and cannot spray many accounts from one IP either.
 */
export const authLimiter = rateLimit({
  ...base('auth', 15 * 60_000, env.RATE_LIMIT_AUTH_MAX),
  skipSuccessfulRequests: true,
  keyGenerator: (req: Request) => {
    const email = typeof req.body?.email === 'string' ? req.body.email.toLowerCase() : 'anon';
    return `${req.ip ?? 'unknown'}:${email}`;
  },
});

/** Tighter budget for mutating routes. */
export const writeLimiter = rateLimit(base('write', 60_000, env.RATE_LIMIT_WRITE_MAX));
