import mongoose, { Types } from 'mongoose';
import { NotFoundError } from '../../lib/errors.js';
import { CACHE_TTL, cached, invalidateUsers, userTag, userTasksKey } from '../../lib/cache.js';
import { supportsTransactions } from '../../lib/db.js';
import { logger } from '../../lib/logger.js';
import { publishTaskEvent } from '../../events/publisher.js';
import { TaskEvent } from '../../events/types.js';
import {
  AssignmentRole,
  HistoryAction,
  Task,
  TaskHistory,
  UserTask,
  type TaskDoc,
} from '../../models/index.js';
import {
  assertCanAssign,
  assertCanDelete,
  assertCanListFor,
  assertCanUpdate,
  assertCanView,
  type Actor,
} from './task.policy.js';
import {
  getTaskFullHistory,
  getTaskInteractors,
  getUserTasksPaginated,
} from './task.aggregations.js';
import type { CreateTaskInput, ListTasksQuery, UpdateTaskInput } from './task.schema.js';

const oid = (id: string) => new Types.ObjectId(id);
const ids = (values: Array<Types.ObjectId | string>) => values.map(String);

/**
 * Runs `work` inside a transaction when the deployment supports one.
 *
 * Task + user_tasks + history must move together, so a replica set (Atlas, and
 * the local compose setup) gets a real transaction. A standalone mongo cannot,
 * so we fall back to running the same work unsessioned rather than refusing to
 * start - the failure mode there is a rare orphaned join row, which the
 * reconcile logic in `syncAssignments` tolerates.
 */
async function withTransaction<T>(
  work: (session?: mongoose.ClientSession) => Promise<T>,
): Promise<T> {
  if (!supportsTransactions()) return work(undefined);

  const session = await mongoose.startSession();
  try {
    let result!: T;
    await session.withTransaction(async () => {
      result = await work(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}

/** Keeps `user_tasks` in step with the denormalised `tasks.assignees` array. */
async function syncAssignments(
  taskId: Types.ObjectId,
  assignees: string[],
  assignedBy: string,
  session?: mongoose.ClientSession,
): Promise<void> {
  const opts = session ? { session } : {};

  await UserTask.deleteMany({ taskId, userId: { $nin: assignees.map(oid) } }, opts);

  if (assignees.length === 0) return;

  await UserTask.bulkWrite(
    assignees.map((userId) => ({
      updateOne: {
        filter: { taskId, userId: oid(userId) },
        update: {
          $setOnInsert: {
            taskId,
            userId: oid(userId),
            role: AssignmentRole.Assignee,
            assignedBy: oid(assignedBy),
            assignedAt: new Date(),
          },
        },
        upsert: true,
      },
    })),
    session ? { session } : {},
  );
}

async function recordHistory(
  entries: Array<Record<string, unknown>>,
  session?: mongoose.ClientSession,
): Promise<void> {
  if (entries.length === 0) return;
  await TaskHistory.insertMany(entries, session ? { session } : {});
}

export async function createTask(input: CreateTaskInput, actor: Actor): Promise<TaskDoc> {
  if (input.assignees.length > 0) assertCanAssign(actor);

  const task = await withTransaction(async (session) => {
    const [created] = await Task.create(
      [
        {
          title: input.title,
          description: input.description,
          status: input.status,
          priority: input.priority,
          dueDate: input.dueDate ?? null,
          createdBy: oid(actor.id),
          assignees: input.assignees.map(oid),
          tags: input.tags,
        },
      ],
      session ? { session } : {},
    );
    if (!created) throw new Error('Task creation returned no document');

    await syncAssignments(created._id, input.assignees, actor.id, session);
    await recordHistory(
      [
        {
          taskId: created._id,
          actorId: oid(actor.id),
          action: HistoryAction.Created,
          newValue: { title: created.title, status: created.status, priority: created.priority },
        },
        ...input.assignees.map((userId) => ({
          taskId: created._id,
          actorId: oid(actor.id),
          action: HistoryAction.Assigned,
          field: 'assignees',
          newValue: userId,
        })),
      ],
      session,
    );

    return created;
  });

  // Side effects run only after the write has committed.
  const recipients = [...new Set([...input.assignees, actor.id])];
  await invalidateUsers(recipients);
  await publishTaskEvent(TaskEvent.Created, {
    taskId: task._id.toString(),
    actorId: actor.id,
    recipients: input.assignees,
    data: { title: task.title, priority: task.priority },
  });

  return task;
}

export async function getTaskById(taskId: string, actor: Actor): Promise<TaskDoc> {
  const task = await Task.findById(taskId)
    .populate('createdBy', 'name email role')
    .populate('assignees', 'name email role');

  if (!task || task.deletedAt) throw new NotFoundError('Task not found');
  assertCanView(task, actor);
  return task;
}

export async function updateTask(
  taskId: string,
  input: UpdateTaskInput,
  actor: Actor,
): Promise<TaskDoc> {
  const existing = await Task.findById(taskId);
  if (!existing || existing.deletedAt) throw new NotFoundError('Task not found');

  assertCanUpdate(existing, actor, Object.keys(input));
  if (input.assignees) assertCanAssign(actor);

  const previousAssignees = ids(existing.assignees);
  const changes: Array<Record<string, unknown>> = [];
  let statusChanged = false;
  let assigneesChanged = false;

  const updated = await withTransaction(async (session) => {
    for (const [field, value] of Object.entries(input) as Array<[keyof UpdateTaskInput, unknown]>) {
      const before = existing.get(field as string);

      if (field === 'assignees') {
        const next = (value as string[]).slice().sort();
        if (JSON.stringify(previousAssignees.slice().sort()) === JSON.stringify(next)) continue;
        assigneesChanged = true;
        changes.push({
          taskId: existing._id,
          actorId: oid(actor.id),
          action: HistoryAction.Assigned,
          field: 'assignees',
          oldValue: previousAssignees,
          newValue: next,
        });
        existing.assignees = (value as string[]).map(oid);
        continue;
      }

      const beforeComparable = before instanceof Date ? before.toISOString() : before;
      const afterComparable = value instanceof Date ? value.toISOString() : value;
      if (JSON.stringify(beforeComparable) === JSON.stringify(afterComparable)) continue;

      if (field === 'status') statusChanged = true;
      changes.push({
        taskId: existing._id,
        actorId: oid(actor.id),
        action: field === 'status' ? HistoryAction.StatusChanged : HistoryAction.Updated,
        field,
        oldValue: beforeComparable ?? null,
        newValue: afterComparable ?? null,
      });
      existing.set(field as string, value);
    }

    // Nothing actually differed - skip the write, the audit row and the event.
    if (changes.length === 0) return existing;

    await existing.save(session ? { session } : {});
    if (assigneesChanged) {
      await syncAssignments(existing._id, ids(existing.assignees), actor.id, session);
    }
    await recordHistory(changes, session);
    return existing;
  });

  if (changes.length === 0) return updated;

  // Both the old and the new assignees have stale cached lists.
  const affected = [...new Set([...previousAssignees, ...ids(updated.assignees), actor.id])];
  await invalidateUsers(affected);

  await publishTaskEvent(statusChanged ? TaskEvent.StatusChanged : TaskEvent.Updated, {
    taskId: updated._id.toString(),
    actorId: actor.id,
    recipients: ids(updated.assignees).filter((id) => id !== actor.id),
    data: { changes: changes.map((c) => ({ field: c.field, newValue: c.newValue })) },
  });

  if (assigneesChanged) {
    const added = ids(updated.assignees).filter((id) => !previousAssignees.includes(id));
    if (added.length > 0) {
      await publishTaskEvent(TaskEvent.Assigned, {
        taskId: updated._id.toString(),
        actorId: actor.id,
        recipients: added,
        data: { title: updated.title },
      });
    }
  }

  return updated;
}

export async function deleteTask(taskId: string, actor: Actor, hard: boolean): Promise<void> {
  assertCanDelete(actor, hard);

  const task = await Task.findById(taskId);
  if (!task || (task.deletedAt && !hard)) throw new NotFoundError('Task not found');

  const affected = [...new Set([...ids(task.assignees), String(task.createdBy), actor.id])];

  await withTransaction(async (session) => {
    if (hard) {
      // Admin-only. The audit trail goes with it - that is the point of a hard
      // delete (GDPR erasure); soft delete is the default everywhere else.
      await Promise.all([
        Task.deleteOne({ _id: task._id }, session ? { session } : {}),
        UserTask.deleteMany({ taskId: task._id }, session ? { session } : {}),
        TaskHistory.deleteMany({ taskId: task._id }, session ? { session } : {}),
      ]);
      return;
    }

    task.deletedAt = new Date();
    await task.save(session ? { session } : {});
    await recordHistory(
      [{ taskId: task._id, actorId: oid(actor.id), action: HistoryAction.Deleted }],
      session,
    );
  });

  await invalidateUsers(affected);
  await publishTaskEvent(TaskEvent.Deleted, {
    taskId,
    actorId: actor.id,
    recipients: affected.filter((id) => id !== actor.id),
    data: { hard },
  });

  logger.info({ taskId, actor: actor.id, hard }, 'Task deleted');
}

/**
 * The cached read path. Cache key covers the full query shape, and the entry
 * is tagged with the target user so any write touching them evicts it.
 */
export async function listUserTasks(
  targetUserId: string,
  query: ListTasksQuery,
  actor: Actor,
): Promise<{ result: Awaited<ReturnType<typeof getUserTasksPaginated>>; cacheHit: boolean }> {
  assertCanListFor(targetUserId, actor);

  const key = userTasksKey(targetUserId, query as unknown as Record<string, unknown>);
  const { value, hit } = await cached(key, [userTag(targetUserId)], CACHE_TTL, () =>
    getUserTasksPaginated(targetUserId, query),
  );

  return { result: value, cacheHit: hit };
}

export async function taskHistory(taskId: string, actor: Actor): Promise<Record<string, unknown>> {
  const task = await Task.findById(taskId).select('createdBy assignees').lean();
  if (!task) throw new NotFoundError('Task not found');
  assertCanView(task as unknown as TaskDoc, actor);

  const result = await getTaskFullHistory(taskId);
  if (!result) throw new NotFoundError('Task not found');
  return result;
}

export async function taskInteractors(
  taskId: string,
  actor: Actor,
): Promise<Record<string, unknown>[]> {
  const task = await Task.findById(taskId).select('createdBy assignees').lean();
  if (!task) throw new NotFoundError('Task not found');
  assertCanView(task as unknown as TaskDoc, actor);

  return getTaskInteractors(taskId);
}
