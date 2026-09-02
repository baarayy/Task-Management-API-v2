import { randomUUID } from 'node:crypto';
import { TASK_EXCHANGE, getChannel } from '../lib/rabbit.js';
import { logger } from '../lib/logger.js';
import type { TaskEventName, TaskEventPayload } from './types.js';

/**
 * Fire-and-forget publish, called *after* the write has committed.
 *
 * A broker outage must not fail the user's request - the write already
 * succeeded and the audit trail lives in Mongo, so the event is a
 * notification concern. Failures are logged for alerting.
 */
export async function publishTaskEvent(
  event: TaskEventName,
  payload: Omit<TaskEventPayload, 'event' | 'occurredAt'>,
): Promise<void> {
  const channel = getChannel();
  if (!channel) {
    logger.debug({ event }, 'RabbitMQ unavailable, event not published');
    return;
  }

  const message: TaskEventPayload = { ...payload, event, occurredAt: new Date().toISOString() };

  try {
    channel.publish(TASK_EXCHANGE, event, Buffer.from(JSON.stringify(message)), {
      persistent: true,
      contentType: 'application/json',
      messageId: randomUUID(),
      timestamp: Date.now(),
    });
    logger.debug({ event, taskId: payload.taskId }, 'Task event published');
  } catch (err) {
    logger.error({ err, event }, 'Failed to publish task event');
  }
}
