import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eventToJobs } from '../../src/events/consumer.js';
import { TaskEvent, type TaskEventPayload } from '../../src/events/types.js';
import { Notification, NotificationType, Role } from '../../src/models/index.js';
import { api, createTestUser, resetDb, startTestDb, stopTestDb } from '../helpers/app.js';

beforeAll(startTestDb);
afterAll(stopTestDb);
afterEach(resetDb);

const event = (overrides: Partial<TaskEventPayload> = {}): TaskEventPayload => ({
  event: TaskEvent.StatusChanged,
  taskId: '650000000000000000001000',
  actorId: 'actor-1',
  recipients: ['user-1', 'user-2'],
  occurredAt: new Date().toISOString(),
  data: { changes: [{ field: 'status', newValue: 'done' }] },
  ...overrides,
});

describe('event to notification-job translation', () => {
  it('produces one job per recipient, carrying the event payload', () => {
    const jobs = eventToJobs(event());

    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toMatchObject({
      userId: 'user-1',
      type: NotificationType.StatusChanged,
      taskId: '650000000000000000001000',
      actorId: 'actor-1',
    });
    expect(jobs[0]!.payload).toEqual({ changes: [{ field: 'status', newValue: 'done' }] });
  });

  it('never notifies the actor about their own action', () => {
    const jobs = eventToJobs(event({ recipients: ['actor-1', 'user-1'] }));
    expect(jobs.map((j) => j.userId)).toEqual(['user-1']);
  });

  it('de-duplicates repeated recipients', () => {
    const jobs = eventToJobs(event({ recipients: ['user-1', 'user-1', 'user-2'] }));
    expect(jobs).toHaveLength(2);
  });

  it('maps each event type to its notification type', () => {
    const cases: Array<[TaskEventPayload['event'], string]> = [
      [TaskEvent.Created, NotificationType.TaskAssigned],
      [TaskEvent.Assigned, NotificationType.TaskAssigned],
      [TaskEvent.StatusChanged, NotificationType.StatusChanged],
      [TaskEvent.Commented, NotificationType.Commented],
      [TaskEvent.Updated, NotificationType.TaskUpdated],
    ];

    for (const [name, expected] of cases) {
      expect(eventToJobs(event({ event: name }))[0]?.type).toBe(expected);
    }
  });

  it('yields nothing when there is no one left to notify', () => {
    expect(eventToJobs(event({ recipients: [] }))).toHaveLength(0);
    expect(eventToJobs(event({ recipients: ['actor-1'] }))).toHaveLength(0);
  });
});

describe('GET /api/v1/notifications', () => {
  it("returns only the caller's own notifications", async () => {
    const owner = await createTestUser(Role.User);
    const stranger = await createTestUser(Role.User);

    await Notification.create([
      { userId: owner.id, type: NotificationType.TaskAssigned, title: 'Yours' },
      { userId: stranger.id, type: NotificationType.TaskAssigned, title: 'Theirs' },
    ]);

    const res = await api()
      .get('/api/v1/notifications')
      .set('Authorization', owner.auth)
      .expect(200);

    expect(res.body.meta.total).toBe(1);
    expect(res.body.data[0].title).toBe('Yours');
  });

  it('filters to unread and reports the unread count', async () => {
    const owner = await createTestUser(Role.User);
    await Notification.create([
      { userId: owner.id, type: NotificationType.TaskUpdated, title: 'Unread' },
      { userId: owner.id, type: NotificationType.TaskUpdated, title: 'Read', readAt: new Date() },
    ]);

    const res = await api()
      .get('/api/v1/notifications?unreadOnly=true')
      .set('Authorization', owner.auth)
      .expect(200);

    expect(res.body.data).toHaveLength(1);
    expect(res.body.meta.unread).toBe(1);
  });

  it('arms the TTL when a notification is marked read', async () => {
    const owner = await createTestUser(Role.User);
    const created = await Notification.create({
      userId: owner.id,
      type: NotificationType.Commented,
      title: 'New comment',
    });

    const res = await api()
      .patch(`/api/v1/notifications/${created._id}/read`)
      .set('Authorization', owner.auth)
      .expect(200);

    expect(res.body.readAt).toBeTruthy();
    // expiresAt drives the TTL index - unread notifications never expire.
    expect(new Date(res.body.expiresAt).getTime()).toBeGreaterThan(Date.now());

    // Marking it read twice is not an error state worth a 200.
    await api()
      .patch(`/api/v1/notifications/${created._id}/read`)
      .set('Authorization', owner.auth)
      .expect(404);
  });

  it("refuses to mark another user's notification as read", async () => {
    const owner = await createTestUser(Role.User);
    const stranger = await createTestUser(Role.User);
    const created = await Notification.create({
      userId: owner.id,
      type: NotificationType.Commented,
      title: 'Private',
    });

    await api()
      .patch(`/api/v1/notifications/${created._id}/read`)
      .set('Authorization', stranger.auth)
      .expect(404);
  });
});
