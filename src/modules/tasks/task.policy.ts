import { ForbiddenError } from '../../lib/errors.js';
import { Role, type RoleType } from '../../models/types.js';
import type { TaskDoc } from '../../models/task.model.js';

/**
 * Row-level authorisation.
 *
 * `requireRole` in the middleware answers "may this role call this route?".
 * These functions answer "may this *person* touch this *record*?" - which is
 * where the real rules live. They are called from the service layer, so they
 * hold even if a route is added without the right middleware.
 *
 *   Admin    full access, including hard delete
 *   Manager  create/assign/read/update any task; soft delete only
 *   User     read tasks they created or are assigned to; may change only
 *            `status` on those; never delete, never reassign
 */

export interface Actor {
  id: string;
  role: RoleType;
}

/**
 * Normalises a reference to its id string.
 *
 * Callers hand these functions tasks in three different shapes: a raw
 * document, a `.lean()` object, and a `.populate()`d document whose refs are
 * whole sub-documents. `String(objectId)` and `String(populatedDoc)` are not
 * the same value, so comparing without this produced a false 403 for a
 * legitimate assignee.
 */
function refId(ref: unknown): string {
  if (ref && typeof ref === 'object' && '_id' in ref) {
    return String((ref as { _id: unknown })._id);
  }
  return String(ref);
}

/** Fields a plain user is allowed to change on a task they are assigned to. */
export const USER_EDITABLE_FIELDS = ['status'] as const;

export function isParticipant(
  task: Pick<TaskDoc, 'createdBy' | 'assignees'>,
  userId: string,
): boolean {
  if (refId(task.createdBy) === userId) return true;
  return (task.assignees ?? []).some((a) => refId(a) === userId);
}

export function assertCanView(task: Pick<TaskDoc, 'createdBy' | 'assignees'>, actor: Actor): void {
  if (actor.role === Role.Admin || actor.role === Role.Manager) return;
  if (!isParticipant(task, actor.id)) {
    // 403 rather than 404: the caller already supplied a valid id, and the
    // API is internal - hiding existence buys little and confuses clients.
    throw new ForbiddenError('You do not have access to this task');
  }
}

export function assertCanUpdate(
  task: Pick<TaskDoc, 'createdBy' | 'assignees'>,
  actor: Actor,
  fields: string[],
): void {
  if (actor.role === Role.Admin || actor.role === Role.Manager) return;

  if (!isParticipant(task, actor.id)) {
    throw new ForbiddenError('You do not have access to this task');
  }

  const disallowed = fields.filter((f) => !(USER_EDITABLE_FIELDS as readonly string[]).includes(f));
  if (disallowed.length > 0) {
    throw new ForbiddenError(
      `Your role may only update: ${USER_EDITABLE_FIELDS.join(', ')}. Rejected: ${disallowed.join(', ')}`,
    );
  }
}

export function assertCanDelete(actor: Actor, hard: boolean): void {
  if (actor.role === Role.User) {
    throw new ForbiddenError('Your role may not delete tasks');
  }
  if (hard && actor.role !== Role.Admin) {
    throw new ForbiddenError('Only an administrator may permanently delete a task');
  }
}

export function assertCanAssign(actor: Actor): void {
  if (actor.role === Role.User) {
    throw new ForbiddenError('Your role may not assign tasks');
  }
}

/**
 * A user may list only their own tasks; managers and admins may list anyone's.
 */
export function assertCanListFor(targetUserId: string, actor: Actor): void {
  if (actor.role === Role.Admin || actor.role === Role.Manager) return;
  if (targetUserId !== actor.id) {
    throw new ForbiddenError('You may only list your own tasks');
  }
}
