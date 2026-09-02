import { createServer } from 'node:http';
import mongoose from 'mongoose';
import { connectDb, disconnectDb } from './lib/db.js';
import { closeRabbit } from './lib/rabbit.js';
import { closeRedis } from './lib/redis.js';
import { startEventConsumer } from './events/consumer.js';
import { startNotificationWorker } from './queues/notification.worker.js';
import { closeNotificationQueue } from './queues/notification.queue.js';
import { logger } from './lib/logger.js';
import { env } from './config/env.js';

/**
 * Background process: consumes RabbitMQ task events, turns them into BullMQ
 * jobs, and processes those jobs. Deployed as its own container so it can be
 * scaled and restarted independently of the API.
 */
/**
 * The worker serves no API traffic, but it still needs a liveness signal: the
 * container healthcheck and an ECS service both need something to poll, and
 * a worker whose broker consumer has died should be replaced rather than left
 * running silently. This is the smallest endpoint that answers that question.
 */
function startHealthServer(isReady: () => boolean): ReturnType<typeof createServer> {
  const port = env.PORT + 1;
  const server = createServer((req, res) => {
    if (req.url !== '/health') {
      res.writeHead(404).end();
      return;
    }
    const healthy = mongoose.connection.readyState === 1 && isReady();
    res.writeHead(healthy ? 200 : 503, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        status: healthy ? 'ok' : 'degraded',
        role: 'worker',
        uptime: process.uptime(),
        dependencies: {
          mongodb: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
        },
      }),
    );
  });
  server.listen(port, () => logger.info({ port }, 'Worker health endpoint listening'));
  return server;
}

async function main(): Promise<void> {
  await connectDb();
  await startEventConsumer();
  const worker = startNotificationWorker();
  const health = startHealthServer(() => worker.isRunning());
  logger.info('Worker started');

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Worker shutting down');
    // close() waits for in-flight jobs so nothing is lost mid-deploy.
    health.close();
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
