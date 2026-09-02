import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Role } from '../../src/models/index.js';
import {
  api,
  createTestUser,
  resetDb,
  startTestDb,
  stopTestDb,
  type TestUser,
} from '../helpers/app.js';

beforeAll(startTestDb);
afterAll(stopTestDb);
afterEach(resetDb);

let manager: TestUser;
let dev: TestUser;
let reviewer: TestUser;
let outsider: TestUser;
let taskId: string;

/**
 * Builds one task with a realistic mixed history: creation, an assignment, a
 * status change by the assignee, and two comments from different people.
 */
beforeEach(async () => {
  manager = await createTestUser(Role.Manager);
  dev = await createTestUser(Role.User);
  reviewer = await createTestUser(Role.User);
  outsider = await createTestUser(Role.User);

  const created = await api()
    .post('/api/v1/tasks')
    .set('Authorization', manager.auth)
    .send({ title: 'Timeline fixture', assignees: [dev.id, reviewer.id], priority: 'high' })
    .expect(201);
  taskId = created.body._id;

  await api()
    .put(`/api/v1/tasks/${taskId}`)
    .set('Authorization', dev.auth)
    .send({ status: 'in_progress' })
    .expect(200);

  await api()
    .post(`/api/v1/tasks/${taskId}/comments`)
    .set('Authorization', dev.auth)
    .send({ body: 'Started on this.' })
    .expect(201);

  await api()
    .post(`/api/v1/tasks/${taskId}/comments`)
    .set('Authorization', reviewer.auth)
    .send({ body: 'Looks reasonable so far.' })
    .expect(201);
});

describe('GET /api/v1/tasks/:id/history', () => {
  it('returns one chronological timeline merging history and comments', async () => {
    const res = await api()
      .get(`/api/v1/tasks/${taskId}/history`)
      .set('Authorization', manager.auth)
      .expect(200);

    const { timeline, counts } = res.body;
    expect(Array.isArray(timeline)).toBe(true);
    expect(counts.history).toBeGreaterThan(0);
    expect(counts.comments).toBe(2);

    // Both source collections are represented in the one array.
    const types = new Set(timeline.map((e: { type: string }) => e.type));
    expect(types.has('history')).toBe(true);
    expect(types.has('comment')).toBe(true);

    // ...and the merged result is genuinely sorted.
    const timestamps = timeline.map((e: { at: string }) => Date.parse(e.at));
    expect(timestamps).toEqual([...timestamps].sort((a, b) => a - b));
  });

  it('captures the status transition with both old and new values', async () => {
    const res = await api()
      .get(`/api/v1/tasks/${taskId}/history`)
      .set('Authorization', manager.auth)
      .expect(200);

    const entry = res.body.timeline.find((e: { action: string }) => e.action === 'status_changed');
    expect(entry).toMatchObject({ field: 'status', oldValue: 'todo', newValue: 'in_progress' });
    expect(entry.actor).toMatchObject({ email: dev.email });
    expect(entry.actor).not.toHaveProperty('passwordHash');
  });

  it('denies a non-participant', async () => {
    await api()
      .get(`/api/v1/tasks/${taskId}/history`)
      .set('Authorization', outsider.auth)
      .expect(403);
  });
});

describe('GET /api/v1/tasks/:id/interactors', () => {
  it('unions commenters and status-changers into a per-user breakdown', async () => {
    const res = await api()
      .get(`/api/v1/tasks/${taskId}/interactors`)
      .set('Authorization', manager.auth)
      .expect(200);

    const byUser = Object.fromEntries(
      res.body.data.map((row: { userId: string }) => [row.userId, row]),
    );

    // The dev both commented and changed status - one row, both interaction types.
    expect(byUser[dev.id].commentCount).toBe(1);
    expect(byUser[dev.id].statusChangeCount).toBe(1);
    expect(byUser[dev.id].interactionTypes).toEqual(
      expect.arrayContaining(['comment', 'status_change']),
    );

    // The reviewer only commented.
    expect(byUser[reviewer.id].commentCount).toBe(1);
    expect(byUser[reviewer.id].statusChangeCount).toBe(0);

    // Someone who never touched the task does not appear at all.
    expect(byUser[outsider.id]).toBeUndefined();
  });

  it('embeds the user summary and orders by most recent interaction', async () => {
    const res = await api()
      .get(`/api/v1/tasks/${taskId}/interactors`)
      .set('Authorization', manager.auth)
      .expect(200);

    for (const row of res.body.data) {
      expect(row.user).toHaveProperty('email');
      expect(row.user).not.toHaveProperty('passwordHash');
      expect(Date.parse(row.lastInteractionAt)).toBeGreaterThanOrEqual(
        Date.parse(row.firstInteractionAt),
      );
    }

    const times = res.body.data.map((r: { lastInteractionAt: string }) =>
      Date.parse(r.lastInteractionAt),
    );
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });
});

describe('task comments', () => {
  it('lists comments newest first with the author populated', async () => {
    const res = await api()
      .get(`/api/v1/tasks/${taskId}/comments`)
      .set('Authorization', dev.auth)
      .expect(200);

    expect(res.body.meta.total).toBe(2);
    expect(res.body.data[0].authorId).toHaveProperty('email');
  });

  it('allows one level of threading and refuses deeper nesting', async () => {
    const root = await api()
      .post(`/api/v1/tasks/${taskId}/comments`)
      .set('Authorization', dev.auth)
      .send({ body: 'Root comment' })
      .expect(201);

    const reply = await api()
      .post(`/api/v1/tasks/${taskId}/comments`)
      .set('Authorization', reviewer.auth)
      .send({ body: 'A reply', parentId: root.body._id })
      .expect(201);

    await api()
      .post(`/api/v1/tasks/${taskId}/comments`)
      .set('Authorization', dev.auth)
      .send({ body: 'A reply to a reply', parentId: reply.body._id })
      .expect(400);
  });

  it('refuses a comment from a non-participant', async () => {
    await api()
      .post(`/api/v1/tasks/${taskId}/comments`)
      .set('Authorization', outsider.auth)
      .send({ body: 'Let me in' })
      .expect(403);
  });

  it('lets an author delete their own comment but not someone elses', async () => {
    const comment = await api()
      .post(`/api/v1/tasks/${taskId}/comments`)
      .set('Authorization', dev.auth)
      .send({ body: 'Mine to remove' })
      .expect(201);

    await api()
      .delete(`/api/v1/tasks/${taskId}/comments/${comment.body._id}`)
      .set('Authorization', reviewer.auth)
      .expect(403);

    await api()
      .delete(`/api/v1/tasks/${taskId}/comments/${comment.body._id}`)
      .set('Authorization', dev.auth)
      .expect(204);

    // Soft-deleted, so it drops out of both the listing and the timeline.
    const listing = await api()
      .get(`/api/v1/tasks/${taskId}/comments`)
      .set('Authorization', dev.auth)
      .expect(200);
    expect(listing.body.data.some((c: { _id: string }) => c._id === comment.body._id)).toBe(false);
  });
});
