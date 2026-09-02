import { createApp } from './app.js';
import { env } from './config/env.js';
import { connectDb, disconnectDb } from './lib/db.js';
import { connectRabbit, closeRabbit } from './lib/rabbit.js';
import { closeRedis, getRedis } from './lib/redis.js';
import { closeNotificationQueue } from './queues/notification.queue.js';
import { logger } from './lib/logger.js';

async function main(): Promise<void> {
  await connectDb();
  getRedis();

  // The API publishes events but does not consume them - that is the worker's
  // job. A broker outage degrades notifications, it does not stop the API.
  await connectRabbit().catch((err) =>
    logger.warn({ err }, 'RabbitMQ unavailable at startup; events will be dropped'),
  );

  const app = createApp();
  const server = app.listen(env.PORT, () => {
    logger.info({ port: env.PORT, env: env.NODE_ENV }, 'API listening');
  });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Shutting down');
    // Stop accepting new connections, let in-flight requests finish, then
    // release dependencies. Without this, a rolling deploy drops requests.
    server.close(async () => {
      await Promise.allSettled([
        closeNotificationQueue(),
        closeRabbit(),
        closeRedis(),
        disconnectDb(),
      ]);
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 15_000).unref();
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  logger.fatal({ err }, 'Failed to start API');
  process.exit(1);
});
