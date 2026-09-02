import type { ConsumeMessage } from 'amqplib';
import { TASK_EXCHANGE, connectRabbit } from '../lib/rabbit.js';
import { logger } from '../lib/logger.js';
import { NotificationType, type NotificationTypeType } from '../models/types.js';
import { enqueueNotifications, type NotificationJob } from '../queues/notification.queue.js';
import { TaskEvent, type TaskEventPayload } from './types.js';

const QUEUE = 'notifications.fanout';

/**
 * Translates broadcast domain events into per-recipient notification jobs.
 *
 * Why both RabbitMQ and BullMQ? They solve different problems:
 *   - RabbitMQ carries *facts* ("task.status_changed happened"). Any number of
 *     consumers can subscribe without the publisher knowing they exist - a
 *     reporting service or an audit sink could be added tomorrow.
 *   - BullMQ carries *work* ("deliver this notification to this user"), with
 *     per-job retries, backoff and a failed-job inspection surface.
 * Collapsing them would mean either losing retry semantics or coupling the
 * publisher to every downstream consumer.
 */
const EVENT_TO_NOTIFICATION: Record<string, NotificationTypeType> = {
  [TaskEvent.Created]: NotificationType.TaskAssigned,
  [TaskEvent.Assigned]: NotificationType.TaskAssigned,
  [TaskEvent.Updated]: NotificationType.TaskUpdated,
  [TaskEvent.StatusChanged]: NotificationType.StatusChanged,
  [TaskEvent.Commented]: NotificationType.Commented,
  [TaskEvent.Deleted]: NotificationType.TaskUpdated,
};

function titleFor(event: TaskEventPayload): string {
  switch (event.event) {
    case TaskEvent.Created:
    case TaskEvent.Assigned:
      return `You were assigned to a task`;
    case TaskEvent.StatusChanged:
      return `A task you follow changed status`;
    case TaskEvent.Commented:
      return `New comment on a task you follow`;
    case TaskEvent.Deleted:
      return `A task you follow was deleted`;
    default:
      return `A task you follow was updated`;
  }
}

/**
 * Pure translation from one broadcast event to the per-recipient jobs it
 * implies. Kept separate from the transport so it can be reasoned about, and
 * tested, without a broker.
 */
export function eventToJobs(event: TaskEventPayload): NotificationJob[] {
  const type = EVENT_TO_NOTIFICATION[event.event] ?? NotificationType.TaskUpdated;

  // De-duplicate recipients, and never notify someone about their own action.
  const recipients = [...new Set(event.recipients ?? [])].filter((id) => id !== event.actorId);

  return recipients.map((userId) => ({
    userId,
    type,
    taskId: event.taskId,
    actorId: event.actorId,
    title: titleFor(event),
    payload: event.data,
  }));
}

export async function startEventConsumer(): Promise<void> {
  const channel = await connectRabbit();

  await channel.assertQueue(QUEUE, {
    durable: true,
    // Poison messages land here instead of being requeued forever.
    deadLetterExchange: '',
    deadLetterRoutingKey: `${QUEUE}.dlq`,
  });
  await channel.assertQueue(`${QUEUE}.dlq`, { durable: true });
  await channel.bindQueue(QUEUE, TASK_EXCHANGE, 'task.*');
  // Bounded prefetch: one slow consumer cannot hoard the whole backlog.
  await channel.prefetch(20);

  await channel.consume(QUEUE, (msg: ConsumeMessage | null) => {
    if (!msg) return;

    void (async () => {
      try {
        const event = JSON.parse(msg.content.toString()) as TaskEventPayload;
        const jobs = eventToJobs(event);

        await enqueueNotifications(jobs);
        channel.ack(msg);
        logger.debug({ event: event.event, jobs: jobs.length }, 'Task event consumed');
      } catch (err) {
        logger.error({ err }, 'Failed to process task event');
        // requeue: false - a message we cannot parse will never parse, so it
        // goes to the DLQ rather than spinning in a redelivery loop.
        channel.nack(msg, false, false);
      }
    })();
  });

  logger.info({ queue: QUEUE }, 'Task event consumer started');
}
