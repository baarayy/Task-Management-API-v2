export const Role = { Admin: 'admin', Manager: 'manager', User: 'user' } as const;
export type RoleType = (typeof Role)[keyof typeof Role];
export const ROLES = Object.values(Role);

export const TaskStatus = {
  Todo: 'todo',
  InProgress: 'in_progress',
  InReview: 'in_review',
  Done: 'done',
  Cancelled: 'cancelled',
} as const;
export type TaskStatusType = (typeof TaskStatus)[keyof typeof TaskStatus];
export const TASK_STATUSES = Object.values(TaskStatus);

export const TaskPriority = {
  Low: 'low',
  Medium: 'medium',
  High: 'high',
  Critical: 'critical',
} as const;
export type TaskPriorityType = (typeof TaskPriority)[keyof typeof TaskPriority];
export const TASK_PRIORITIES = Object.values(TaskPriority);

export const AssignmentRole = {
  Owner: 'owner',
  Assignee: 'assignee',
  Reviewer: 'reviewer',
  Watcher: 'watcher',
} as const;
export type AssignmentRoleType = (typeof AssignmentRole)[keyof typeof AssignmentRole];
export const ASSIGNMENT_ROLES = Object.values(AssignmentRole);

export const HistoryAction = {
  Created: 'created',
  Updated: 'updated',
  StatusChanged: 'status_changed',
  Assigned: 'assigned',
  Unassigned: 'unassigned',
  Commented: 'commented',
  Deleted: 'deleted',
  Restored: 'restored',
} as const;
export type HistoryActionType = (typeof HistoryAction)[keyof typeof HistoryAction];
export const HISTORY_ACTIONS = Object.values(HistoryAction);

export const NotificationType = {
  TaskAssigned: 'task_assigned',
  TaskUpdated: 'task_updated',
  StatusChanged: 'status_changed',
  Commented: 'commented',
  Mentioned: 'mentioned',
  DueSoon: 'due_soon',
} as const;
export type NotificationTypeType = (typeof NotificationType)[keyof typeof NotificationType];
export const NOTIFICATION_TYPES = Object.values(NotificationType);

/** Collection names, referenced by $lookup/$unionWith stages in aggregations. */
export const Collections = {
  Users: 'users',
  Tasks: 'tasks',
  TaskHistory: 'task_history',
  TaskComments: 'task_comments',
  Notifications: 'notifications',
  UserTasks: 'user_tasks',
} as const;
