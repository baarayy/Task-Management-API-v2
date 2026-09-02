import { connectDb, disconnectDb } from './lib/db.js';
import { closeRabbit } from './lib/rabbit.js';
import { closeRedis } from './lib/redis.js';
import { startEventConsumer } from './events/consumer.js';
import { startNotificationWorker } from './queues/notification.worker.js';
import { closeNotificationQueue } from './queues/notification.queue.js';
import { logger } from './lib/logger.js';

/**
 * Background process: consumes RabbitMQ task events, turns them into BullMQ
 * jobs, and processes those jobs. Deployed as its own container so it can be
 * scaled and restarted independently of the API.
 */
async function main(): Promise<void> {
  await connectDb();
  await startEventConsumer();
  const worker = startNotificationWorker();
  logger.info('Worker started');

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Worker shutting down');
    // close() waits for in-flight jobs so nothing is lost mid-deploy.
    await Promise.allSettled([
      worker.close(),
      closeNotificationQueue(),
      closeRabbit(),
      closeRedis(),
      disconnectDb(),
    ]);
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  logger.fatal({ err }, 'Failed to start worker');
  process.exit(1);
});
