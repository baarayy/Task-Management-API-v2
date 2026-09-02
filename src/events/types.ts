export const TaskEvent = {
  Created: 'task.created',
  Updated: 'task.updated',
  StatusChanged: 'task.status_changed',
  Assigned: 'task.assigned',
  Commented: 'task.commented',
  Deleted: 'task.deleted',
} as const;

export type TaskEventName = (typeof TaskEvent)[keyof typeof TaskEvent];

export interface TaskEventPayload {
  event: TaskEventName;
  taskId: string;
  actorId: string;
  /** Users who should be told about this event (assignees, creator, mentions). */
  recipients: string[];
  occurredAt: string;
  data: Record<string, unknown>;
}
