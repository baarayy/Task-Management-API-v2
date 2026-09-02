import { Worker, type Job } from 'bullmq';
import { createBullConnection } from '../lib/redis.js';
import { logger } from '../lib/logger.js';
import { Notification } from '../models/notification.model.js';
import { NOTIFICATION_QUEUE, type NotificationJob } from './notification.queue.js';

/**
 * Runs in its own process (see src/worker.ts and the `worker` service in
 * docker-compose). Keeping it out of the API process means a burst of
 * notification work cannot starve the request event loop, and the two can be
 * scaled independently.
 */
export function startNotificationWorker(): Worker<NotificationJob> {
  const worker = new Worker<NotificationJob>(
    NOTIFICATION_QUEUE,
    async (job: Job<NotificationJob>) => {
      const { userId, type, taskId, actorId, title, payload } = job.data;

      const notification = await Notification.create({
        userId,
        type,
        taskId: taskId ?? null,
        actorId: actorId ?? null,
        title,
        payload,
      });

      // Stand-in for a real transport (SES, Twilio, web push). Kept as a log
      // line so the project runs with no external accounts or credentials.
      logger.info(
        { jobId: job.id, userId, type, taskId, notificationId: notification._id.toString() },
        'Notification delivered',
      );

      return { notificationId: notification._id.toString() };
    },
    {
      connection: createBullConnection(),
      concurrency: 5,
      limiter: { max: 100, duration: 1000 },
    },
  );

  worker.on('completed', (job) => logger.debug({ jobId: job.id }, 'Notification job completed'));
  worker.on('failed', (job, err) =>
    logger.error({ jobId: job?.id, attempts: job?.attemptsMade, err }, 'Notification job failed'),
  );
  worker.on('error', (err) => logger.error({ err }, 'Notification worker error'));

  return worker;
}
