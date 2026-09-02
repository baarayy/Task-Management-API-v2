/**
 * Global test setup. Runs before any module under test is imported, which
 * matters because src/config/env.ts validates the environment at import time.
 */
process.env.NODE_ENV = 'test';
process.env.MONGO_URI = 'mongodb://127.0.0.1:27017/placeholder';
process.env.JWT_ACCESS_SECRET = 'test-access-secret-that-is-at-least-32-characters-long';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-that-is-at-least-32-characters-long';
process.env.LOG_LEVEL = 'silent';
process.env.CACHE_TTL_SECONDS = '300';

import { vi } from 'vitest';
import { redisMock } from './redisMock.js';

// Redis is stubbed in-process; BullMQ and RabbitMQ are stubbed at their module
// boundaries. The tests assert on API behaviour, not on the brokers.
vi.mock('../../src/lib/redis.js', () => ({
  getRedis: () => redisMock,
  createBullConnection: () => redisMock,
  closeRedis: async () => undefined,
}));

vi.mock('../../src/queues/notification.queue.js', () => ({
  NOTIFICATION_QUEUE: 'notifications',
  getNotificationQueue: () => ({ addBulk: async () => [], close: async () => undefined }),
  enqueueNotifications: vi.fn(async () => undefined),
  closeNotificationQueue: async () => undefined,
}));

vi.mock('../../src/lib/rabbit.js', () => ({
  TASK_EXCHANGE: 'task.events',
  connectRabbit: async () => null,
  getChannel: () => null,
  closeRabbit: async () => undefined,
}));
