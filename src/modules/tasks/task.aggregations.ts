import { Types, type PipelineStage } from 'mongoose';
import { Task } from '../../models/task.model.js';
import { TaskComment } from '../../models/taskComment.model.js';
import { Collections, HistoryAction } from '../../models/types.js';
import type { ListTasksQuery } from './task.schema.js';

const oid = (id: string) => new Types.ObjectId(id);

/** Projection reused wherever a user is embedded in a result. */
const USER_SUMMARY = { _id: 1, name: 1, email: 1, role: 1 } as const;

export interface Paginated<T> {
  data: T[];
  meta: { page: number; limit: number; total: number; totalPages: number; hasNext: boolean };
}

/**
 * ── 1. Tasks assigned to a user, paginated and filtered ──────────────────────
 *
 * Backed by { assignees, deletedAt, status, dueDate }. The $match is written
 * so the leading multikey field is an equality on the user id, which lets
 * Mongo seek straight into the index rather than scanning.
 *
 * $facet runs the page and the count in ONE round trip. The naive alternative
 * (find + countDocuments) is two queries that can also disagree under
 * concurrent writes; $facet reads a single consistent snapshot.
 */
export async function getUserTasksPaginated(
  userId: string,
  q: ListTasksQuery,
): Promise<Paginated<Record<string, unknown>>> {
  const match: Record<string, unknown> = { assignees: oid(userId) };

  if (!q.includeDeleted) match.deletedAt = null;
  if (q.status?.length) match.status = { $in: q.status };
  if (q.priority?.length) match.priority = { $in: q.priority };
  if (q.tags?.length) match.tags = { $in: q.tags };

  if (q.dueBefore || q.dueAfter) {
    const range: Record<string, Date> = {};
    if (q.dueAfter) range.$gte = q.dueAfter;
    if (q.dueBefore) range.$lte = q.dueBefore;
    match.dueDate = range;
  }

  // $text must be the first stage's condition, so full-text search and the
  // rest of the filter go into the same $match.
  if (q.q) match.$text = { $search: q.q };

  const skip = (q.page - 1) * q.limit;
  const direction = q.sortOrder === 'asc' ? 1 : -1;

  const pipeline: PipelineStage[] = [
    { $match: match },
    {
      $facet: {
        // Page slice: sort/skip/limit BEFORE the $lookup so the join only
        // ever runs against the <=100 documents actually being returned.
        data: [
          { $sort: { [q.sortBy]: direction, _id: direction } as Record<string, 1 | -1> },
          { $skip: skip },
          { $limit: q.limit },
          {
            $lookup: {
              from: Collections.Users,
              localField: 'assignees',
              foreignField: '_id',
              as: 'assignees',
              pipeline: [{ $project: USER_SUMMARY }],
            },
          },
          {
            $lookup: {
              from: Collections.Users,
              localField: 'createdBy',
              foreignField: '_id',
              as: 'createdBy',
              pipeline: [{ $project: USER_SUMMARY }],
            },
          },
          { $unwind: { path: '$createdBy', preserveNullAndEmptyArrays: true } },
          {
            $lookup: {
              from: Collections.TaskComments,
              let: { taskId: '$_id' },
              as: 'commentCount',
              pipeline: [
                { $match: { $expr: { $eq: ['$taskId', '$$taskId'] }, deletedAt: null } },
                { $count: 'count' },
              ],
            },
          },
          {
            $addFields: {
              commentCount: { $ifNull: [{ $first: '$commentCount.count' }, 0] },
            },
          },
          { $project: { __v: 0 } },
        ],
        // Count branch: covered by the same index, no documents fetched.
        total: [{ $count: 'count' }],
      },
    },
  ];

  const [result] = await Task.aggregate(pipeline).allowDiskUse(false);
  const data = (result?.data ?? []) as Record<string, unknown>[];
  const total = (result?.total?.[0]?.count as number | undefined) ?? 0;

  return {
    data,
    meta: {
      page: q.page,
      limit: q.limit,
      total,
      totalPages: Math.ceil(total / q.limit),
      hasNext: skip + data.length < total,
    },
  };
}

/**
 * ── 2. A task's full history ─────────────────────────────────────────────────
 *
 * Status changes, comments and notifications are three collections with three
 * different shapes. Rather than make the client fetch and merge them, each is
 * $lookup'd, normalised via $project into a common {type, at, actor, ...}
 * shape, then folded into one array with $concatArrays and sorted.
 *
 * The result is one document containing a single chronological timeline -
 * which is what "a task's full history" actually means to a consumer.
 */
export async function getTaskFullHistory(taskId: string): Promise<Record<string, unknown> | null> {
  const pipeline: PipelineStage[] = [
    { $match: { _id: oid(taskId) } },

    {
      $lookup: {
        from: Collections.TaskHistory,
        let: { taskId: '$_id' },
        as: 'historyEntries',
        pipeline: [
          { $match: { $expr: { $eq: ['$taskId', '$$taskId'] } } },
          {
            $lookup: {
              from: Collections.Users,
              localField: 'actorId',
              foreignField: '_id',
              as: 'actor',
              pipeline: [{ $project: USER_SUMMARY }],
            },
          },
          { $unwind: { path: '$actor', preserveNullAndEmptyArrays: true } },
          {
            $project: {
              _id: 1,
              type: { $literal: 'history' },
              at: '$createdAt',
              actor: 1,
              action: 1,
              field: 1,
              oldValue: 1,
              newValue: 1,
            },
          },
        ],
      },
    },

    {
      $lookup: {
        from: Collections.TaskComments,
        let: { taskId: '$_id' },
        as: 'commentEntries',
        pipeline: [
          { $match: { $expr: { $eq: ['$taskId', '$$taskId'] }, deletedAt: null } },
          {
            $lookup: {
              from: Collections.Users,
              localField: 'authorId',
              foreignField: '_id',
              as: 'actor',
              pipeline: [{ $project: USER_SUMMARY }],
            },
          },
          { $unwind: { path: '$actor', preserveNullAndEmptyArrays: true } },
          {
            $project: {
              _id: 1,
              type: { $literal: 'comment' },
              at: '$createdAt',
              actor: 1,
              action: { $literal: 'commented' },
              body: 1,
              parentId: 1,
            },
          },
        ],
      },
    },

    {
      $lookup: {
        from: Collections.Notifications,
        let: { taskId: '$_id' },
        as: 'notificationEntries',
        pipeline: [
          { $match: { $expr: { $eq: ['$taskId', '$$taskId'] } } },
          {
            $project: {
              _id: 1,
              type: { $literal: 'notification' },
              at: '$createdAt',
              notificationType: '$type',
              title: 1,
              userId: 1,
              readAt: 1,
            },
          },
        ],
      },
    },

    {
      $lookup: {
        from: Collections.Users,
        localField: 'assignees',
        foreignField: '_id',
        as: 'assignees',
        pipeline: [{ $project: USER_SUMMARY }],
      },
    },

    {
      $addFields: {
        timeline: {
          $sortArray: {
            input: {
              $concatArrays: ['$historyEntries', '$commentEntries', '$notificationEntries'],
            },
            // `_id` breaks ties: several entries can share a millisecond
            // (a create plus its assignment rows), and sorting on `at` alone
            // leaves their relative order unspecified between runs.
            sortBy: { at: 1, _id: 1 },
          },
        },
        counts: {
          history: { $size: '$historyEntries' },
          comments: { $size: '$commentEntries' },
          notifications: { $size: '$notificationEntries' },
        },
      },
    },

    { $project: { historyEntries: 0, commentEntries: 0, notificationEntries: 0, __v: 0 } },
  ];

  const [doc] = await Task.aggregate(pipeline);
  return (doc as Record<string, unknown> | undefined) ?? null;
}

/**
 * ── 3. Users who interacted with a task ──────────────────────────────────────
 *
 * "Interacted" spans two collections, so the pipeline starts from comments and
 * $unionWith's the history entries, normalising both to {userId, kind}. One
 * $group per user then yields the interaction breakdown.
 *
 * $unionWith beats issuing two queries and merging in Node: the grouping and
 * the de-duplication happen in the database, next to the data.
 */
export async function getTaskInteractors(taskId: string): Promise<Record<string, unknown>[]> {
  const id = oid(taskId);

  const pipeline: PipelineStage[] = [
    { $match: { taskId: id, deletedAt: null } },
    { $project: { userId: '$authorId', kind: { $literal: 'comment' }, at: '$createdAt' } },

    {
      $unionWith: {
        coll: Collections.TaskHistory,
        pipeline: [
          /*
           * `commented` history rows mirror documents already counted from
           * task_comments. Including them would double-count the interaction
           * and surface two labels ('comment' and 'commented') for one act,
           * so the comments collection stays the single source for that kind.
           */
          { $match: { taskId: id, action: { $ne: HistoryAction.Commented } } },
          {
            $project: {
              userId: '$actorId',
              kind: {
                $cond: [
                  { $eq: ['$action', HistoryAction.StatusChanged] },
                  'status_change',
                  '$action',
                ],
              },
              at: '$createdAt',
            },
          },
        ],
      },
    },

    {
      $group: {
        _id: '$userId',
        interactionTypes: { $addToSet: '$kind' },
        totalInteractions: { $sum: 1 },
        commentCount: { $sum: { $cond: [{ $eq: ['$kind', 'comment'] }, 1, 0] } },
        statusChangeCount: { $sum: { $cond: [{ $eq: ['$kind', 'status_change'] }, 1, 0] } },
        firstInteractionAt: { $min: '$at' },
        lastInteractionAt: { $max: '$at' },
      },
    },

    {
      $lookup: {
        from: Collections.Users,
        localField: '_id',
        foreignField: '_id',
        as: 'user',
        pipeline: [{ $project: USER_SUMMARY }],
      },
    },
    { $unwind: { path: '$user', preserveNullAndEmptyArrays: true } },

    { $sort: { lastInteractionAt: -1 } },
    {
      $project: {
        _id: 0,
        userId: '$_id',
        user: 1,
        interactionTypes: 1,
        totalInteractions: 1,
        commentCount: 1,
        statusChangeCount: 1,
        firstInteractionAt: 1,
        lastInteractionAt: 1,
      },
    },
  ];

  return TaskComment.aggregate(pipeline);
}
