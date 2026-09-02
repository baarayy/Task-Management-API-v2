import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Role, Task, TaskHistory, UserTask } from '../../src/models/index.js';
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

let admin: TestUser;
let manager: TestUser;
let assignee: TestUser;
let outsider: TestUser;

beforeEach(async () => {
  admin = await createTestUser(Role.Admin);
  manager = await createTestUser(Role.Manager);
  assignee = await createTestUser(Role.User);
  outsider = await createTestUser(Role.User);
});

async function createTask(overrides: Record<string, unknown> = {}, as: TestUser = manager) {
  const res = await api()
    .post('/api/v1/tasks')
    .set('Authorization', as.auth)
    .send({ title: 'Seeded task', assignees: [assignee.id], ...overrides })
    .expect(201);
  return res.body;
}

describe('POST /api/v1/tasks', () => {
  it('creates a task, the join rows and the audit trail together', async () => {
    const task = await createTask({ title: 'Ship the API', priority: 'high', tags: ['api'] });

    expect(task).toMatchObject({ title: 'Ship the API', priority: 'high', status: 'todo' });

    // The many-to-many join is written alongside the denormalised array.
    const joins = await UserTask.find({ taskId: task._id }).lean();
    expect(joins).toHaveLength(1);
    expect(String(joins[0]!.userId)).toBe(assignee.id);
    expect(String(joins[0]!.assignedBy)).toBe(manager.id);

    const history = await TaskHistory.find({ taskId: task._id }).lean();
    expect(history.map((h) => h.action).sort()).toEqual(['assigned', 'created']);
  });

  it('rejects creation by a plain user', async () => {
    await api()
      .post('/api/v1/tasks')
      .set('Authorization', assignee.auth)
      .send({ title: 'Not allowed' })
      .expect(403);
  });

  it('validates and bounds the payload', async () => {
    await api().post('/api/v1/tasks').set('Authorization', manager.auth).send({}).expect(400);
    await api()
      .post('/api/v1/tasks')
      .set('Authorization', manager.auth)
      .send({ title: 'x', status: 'not_a_status' })
      .expect(400);
    await api()
      .post('/api/v1/tasks')
      .set('Authorization', manager.auth)
      .send({ title: 'x', assignees: ['not-an-objectid'] })
      .expect(400);
  });
});

describe('GET /api/v1/tasks/:id', () => {
  it('returns the task to a participant and to a manager', async () => {
    const task = await createTask();
    await api().get(`/api/v1/tasks/${task._id}`).set('Authorization', assignee.auth).expect(200);
    await api().get(`/api/v1/tasks/${task._id}`).set('Authorization', admin.auth).expect(200);
  });

  it('denies a user who is neither creator nor assignee', async () => {
    const task = await createTask();
    await api().get(`/api/v1/tasks/${task._id}`).set('Authorization', outsider.auth).expect(403);
  });

  it('404s for an unknown id and 400s for a malformed one', async () => {
    await api()
      .get('/api/v1/tasks/650000000000000000000999')
      .set('Authorization', admin.auth)
      .expect(404);
    await api().get('/api/v1/tasks/nonsense').set('Authorization', admin.auth).expect(400);
  });
});

describe('PUT /api/v1/tasks/:id', () => {
  it('records one history entry per changed field', async () => {
    const task = await createTask({ title: 'Before', priority: 'low' });

    await api()
      .put(`/api/v1/tasks/${task._id}`)
      .set('Authorization', manager.auth)
      .send({ title: 'After', priority: 'critical', status: 'in_progress' })
      .expect(200);

    const history = await TaskHistory.find({ taskId: task._id, action: { $ne: 'created' } }).lean();
    const fields = history
      .map((h) => h.field)
      .filter(Boolean)
      .sort();
    expect(fields).toEqual(['assignees', 'priority', 'status', 'title']);

    const statusEntry = history.find((h) => h.action === 'status_changed');
    expect(statusEntry).toMatchObject({ oldValue: 'todo', newValue: 'in_progress' });
  });

  it('writes nothing when the submitted values match the current ones', async () => {
    const task = await createTask({ title: 'Same', priority: 'medium' });
    const before = await TaskHistory.countDocuments({ taskId: task._id });

    await api()
      .put(`/api/v1/tasks/${task._id}`)
      .set('Authorization', manager.auth)
      .send({ title: 'Same', priority: 'medium' })
      .expect(200);

    expect(await TaskHistory.countDocuments({ taskId: task._id })).toBe(before);
  });

  it('lets an assignee change status but nothing else', async () => {
    const task = await createTask();

    await api()
      .put(`/api/v1/tasks/${task._id}`)
      .set('Authorization', assignee.auth)
      .send({ status: 'in_progress' })
      .expect(200);

    const res = await api()
      .put(`/api/v1/tasks/${task._id}`)
      .set('Authorization', assignee.auth)
      .send({ title: 'Renamed by a user' })
      .expect(403);

    expect(res.body.error.message).toContain('status');
  });

  it('denies a non-participant entirely', async () => {
    const task = await createTask();
    await api()
      .put(`/api/v1/tasks/${task._id}`)
      .set('Authorization', outsider.auth)
      .send({ status: 'done' })
      .expect(403);
  });

  it('reconciles the join collection when assignees change', async () => {
    const task = await createTask();

    await api()
      .put(`/api/v1/tasks/${task._id}`)
      .set('Authorization', manager.auth)
      .send({ assignees: [outsider.id] })
      .expect(200);

    const joins = await UserTask.find({ taskId: task._id }).lean();
    expect(joins).toHaveLength(1);
    expect(String(joins[0]!.userId)).toBe(outsider.id);
  });
});

describe('DELETE /api/v1/tasks/:id', () => {
  it('soft deletes for a manager, keeping the audit trail', async () => {
    const task = await createTask();

    await api().delete(`/api/v1/tasks/${task._id}`).set('Authorization', manager.auth).expect(204);

    const stored = await Task.findById(task._id).lean();
    expect(stored?.deletedAt).toBeInstanceOf(Date);
    expect(await TaskHistory.countDocuments({ taskId: task._id })).toBeGreaterThan(0);

    // Soft-deleted tasks are invisible to the read endpoints.
    await api().get(`/api/v1/tasks/${task._id}`).set('Authorization', manager.auth).expect(404);
  });

  it('refuses deletion by a plain user', async () => {
    const task = await createTask();
    await api().delete(`/api/v1/tasks/${task._id}`).set('Authorization', assignee.auth).expect(403);
  });

  it('allows a hard delete only for an admin', async () => {
    const task = await createTask();

    await api()
      .delete(`/api/v1/tasks/${task._id}?hard=true`)
      .set('Authorization', manager.auth)
      .expect(403);

    await api()
      .delete(`/api/v1/tasks/${task._id}?hard=true`)
      .set('Authorization', admin.auth)
      .expect(204);

    expect(await Task.findById(task._id).lean()).toBeNull();
    expect(await UserTask.countDocuments({ taskId: task._id })).toBe(0);
    expect(await TaskHistory.countDocuments({ taskId: task._id })).toBe(0);
  });
});
