import amqp, { type Channel, type ChannelModel } from 'amqplib';
import { env } from '../config/env.js';
import { logger } from './logger.js';

export const TASK_EXCHANGE = 'task.events';

let connection: ChannelModel | null = null;
let channel: Channel | null = null;

/**
 * Topic exchange. Publishers emit `task.<verb>`; consumers bind whatever
 * subset they care about (`task.*`, `task.status_changed`, ...). New consumers
 * can be added without touching the publisher - the point of the exchange.
 */
export async function connectRabbit(url: string = env.RABBITMQ_URL): Promise<Channel> {
  if (channel) return channel;

  connection = await amqp.connect(url);
  connection.on('error', (err: unknown) => logger.error({ err }, 'RabbitMQ connection error'));
  connection.on('close', () => {
    logger.warn('RabbitMQ connection closed');
    connection = null;
    channel = null;
  });

  channel = await connection.createChannel();
  await channel.assertExchange(TASK_EXCHANGE, 'topic', { durable: true });
  logger.info('RabbitMQ connected');
  return channel;
}

export function getChannel(): Channel | null {
  return channel;
}

export async function closeRabbit(): Promise<void> {
  try {
    await channel?.close();
    await connection?.close();
  } catch (err) {
    logger.warn({ err }, 'Error closing RabbitMQ');
  } finally {
    channel = null;
    connection = null;
  }
}
