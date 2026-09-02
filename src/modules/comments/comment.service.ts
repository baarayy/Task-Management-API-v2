import { Types } from 'mongoose';
import { BadRequestError, ForbiddenError, NotFoundError } from '../../lib/errors.js';
import { invalidateUsers } from '../../lib/cache.js';
import { publishTaskEvent } from '../../events/publisher.js';
import { TaskEvent } from '../../events/types.js';
import { HistoryAction, Role, Task, TaskComment, TaskHistory } from '../../models/index.js';
import { assertCanView, type Actor } from '../tasks/task.policy.js';
import type { CreateCommentInput, ListCommentsQuery } from './comment.schema.js';

const oid = (id: string) => new Types.ObjectId(id);

export async function addComment(taskId: string, input: CreateCommentInput, actor: Actor) {
  const task = await Task.findById(taskId);
  if (!task || task.deletedAt) throw new NotFoundError('Task not found');
  // Commenting requires the same visibility as reading - no back door into a
  // task you are not part of.
  assertCanView(task, actor);

  if (input.parentId) {
    const parent = await TaskComment.findOne({ _id: input.parentId, taskId: task._id }).lean();
    if (!parent) throw new BadRequestError('Parent comment does not belong to this task');
    // One level of threading only; deeper nesting is a UI problem, not a data one.
    if (parent.parentId) throw new BadRequestError('Comments can only be nested one level deep');
  }

  const comment = await TaskComment.create({
    taskId: task._id,
    authorId: oid(actor.id),
    body: input.body,
    parentId: input.parentId ?? null,
    mentions: input.mentions.map(oid),
  });

  await TaskHistory.create({
    taskId: task._id,
    actorId: oid(actor.id),
    action: HistoryAction.Commented,
    metadata: { commentId: comment._id },
  });

  const participants = [...new Set([...task.assignees.map(String), String(task.createdBy)])];
  await invalidateUsers(participants);

  await publishTaskEvent(TaskEvent.Commented, {
    taskId: task._id.toString(),
    actorId: actor.id,
    recipients: [...new Set([...participants, ...input.mentions])].filter((id) => id !== actor.id),
    data: { commentId: comment._id.toString(), mentions: input.mentions },
  });

  return comment;
}

export async function listComments(taskId: string, q: ListCommentsQuery, actor: Actor) {
  const task = await Task.findById(taskId).select('createdBy assignees deletedAt').lean();
  if (!task) throw new NotFoundError('Task not found');
  assertCanView(task as never, actor);

  const filter = { taskId: oid(taskId), deletedAt: null };
  const skip = (q.page - 1) * q.limit;

  const [data, total] = await Promise.all([
    TaskComment.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(q.limit)
      .populate('authorId', 'name email role')
      .lean(),
    TaskComment.countDocuments(filter),
  ]);

  return {
    data,
    meta: { page: q.page, limit: q.limit, total, totalPages: Math.ceil(total / q.limit) },
  };
}

/** Soft delete: the author, or a manager/admin moderating the thread. */
export async function deleteComment(taskId: string, commentId: string, actor: Actor) {
  const comment = await TaskComment.findOne({ _id: commentId, taskId: oid(taskId) });
  if (!comment || comment.deletedAt) throw new NotFoundError('Comment not found');

  const isAuthor = String(comment.authorId) === actor.id;
  const isModerator = actor.role === Role.Admin || actor.role === Role.Manager;
  if (!isAuthor && !isModerator) {
    throw new ForbiddenError('You may only delete your own comments');
  }

  comment.deletedAt = new Date();
  await comment.save();
}
