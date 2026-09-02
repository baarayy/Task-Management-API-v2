import { Queue } from 'bullmq';
import { createBullConnection } from '../lib/redis.js';
import { logger } from '../lib/logger.js';
import type { NotificationTypeType } from '../models/types.js';

export const NOTIFICATION_QUEUE = 'notifications';

export interface NotificationJob {
  userId: string;
  type: NotificationTypeType;
  taskId?: string;
  actorId?: string;
  title: string;
  payload?: Record<string, unknown>;
}

let queue: Queue<NotificationJob> | null = null;

export function getNotificationQueue(): Queue<NotificationJob> {
  if (queue) return queue;
  queue = new Queue<NotificationJob>(NOTIFICATION_QUEUE, {
    connection: createBullConnection(),
    defaultJobOptions: {
      // Transient failures (Redis blip, downstream mail provider) are retried
      // with backoff; after 3 attempts the job stays in `failed` and is
      // inspectable rather than silently lost.
      attempts: 3,
      backoff: { type: 'exponential', delay: 2_000 },
      removeOnComplete: { age: 3600, count: 1000 },
      removeOnFail: { age: 7 * 24 * 3600 },
    },
  });
  queue.on('error', (err) => logger.error({ err }, 'Notification queue error'));
  return queue;
}

export async function enqueueNotifications(jobs: NotificationJob[]): Promise<void> {
  if (jobs.length === 0) return;
  try {
    await getNotificationQueue().addBulk(jobs.map((data) => ({ name: data.type, data })));
  } catch (err) {
    // Never fail the originating request because a notification could not be
    // queued - the write it describes has already committed.
    logger.error({ err, count: jobs.length }, 'Failed to enqueue notifications');
  }
}

export async function closeNotificationQueue(): Promise<void> {
  await queue?.close();
  queue = null;
}
