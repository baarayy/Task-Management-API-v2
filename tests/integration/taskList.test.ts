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
let owner: TestUser;
let other: TestUser;

/** 12 tasks with a spread of statuses, priorities and due dates. */
async function seedTasks(): Promise<void> {
  const statuses = ['todo', 'in_progress', 'done'];
  const priorities = ['low', 'high'];

  for (let i = 0; i < 12; i += 1) {
    await api()
      .post('/api/v1/tasks')
      .set('Authorization', manager.auth)
      .send({
        title: `Task ${String(i).padStart(2, '0')}`,
        status: statuses[i % 3],
        priority: priorities[i % 2],
        dueDate: new Date(Date.UTC(2026, 8, i + 1)).toISOString(),
        assignees: [owner.id],
        tags: i % 2 === 0 ? ['api'] : ['infra'],
      })
      .expect(201);
  }
}

beforeEach(async () => {
  manager = await createTestUser(Role.Manager);
  owner = await createTestUser(Role.User);
  other = await createTestUser(Role.User);
});

const list = (as: TestUser, userId: string, qs = '') =>
  api().get(`/api/v1/tasks/user/${userId}${qs}`).set('Authorization', as.auth);

describe('GET /api/v1/tasks/user/:userId', () => {
  it('paginates with accurate metadata', async () => {
    await seedTasks();

    const page1 = await list(owner, owner.id, '?page=1&limit=5').expect(200);
    expect(page1.body.data).toHaveLength(5);
    expect(page1.body.meta).toMatchObject({
      page: 1,
      limit: 5,
      total: 12,
      totalPages: 3,
      hasNext: true,
    });

    const page3 = await list(owner, owner.id, '?page=3&limit=5').expect(200);
    expect(page3.body.data).toHaveLength(2);
    expect(page3.body.meta.hasNext).toBe(false);

    // Pages must not overlap.
    const ids1 = page1.body.data.map((t: { _id: string }) => t._id);
    const ids3 = page3.body.data.map((t: { _id: string }) => t._id);
    expect(ids1.filter((id: string) => ids3.includes(id))).toHaveLength(0);
  });

  it('filters by status, priority, tag and due-date range', async () => {
    await seedTasks();

    const byStatus = await list(owner, owner.id, '?status=todo&limit=100').expect(200);
    expect(byStatus.body.data.every((t: { status: string }) => t.status === 'todo')).toBe(true);

    const byPriority = await list(owner, owner.id, '?priority=high&limit=100').expect(200);
    expect(byPriority.body.data.every((t: { priority: string }) => t.priority === 'high')).toBe(
      true,
    );

    const byTag = await list(owner, owner.id, '?tags=api&limit=100').expect(200);
    expect(byTag.body.data.every((t: { tags: string[] }) => t.tags.includes('api'))).toBe(true);

    const byDate = await list(
      owner,
      owner.id,
      '?dueAfter=2026-09-03T00:00:00.000Z&dueBefore=2026-09-06T00:00:00.000Z&limit=100',
    ).expect(200);
    expect(byDate.body.data).toHaveLength(4);
  });

  it('combines filters conjunctively', async () => {
    await seedTasks();
    const res = await list(owner, owner.id, '?status=todo&priority=low&limit=100').expect(200);
    for (const task of res.body.data) {
      expect(task.status).toBe('todo');
      expect(task.priority).toBe('low');
    }
  });

  it('sorts on a whitelisted field in both directions', async () => {
    await seedTasks();

    const asc = await list(owner, owner.id, '?sortBy=dueDate&sortOrder=asc&limit=100').expect(200);
    const desc = await list(owner, owner.id, '?sortBy=dueDate&sortOrder=desc&limit=100').expect(
      200,
    );

    const dates = asc.body.data.map((t: { dueDate: string }) => t.dueDate);
    expect(dates).toEqual([...dates].sort());
    expect(desc.body.data[0].dueDate).toBe(asc.body.data[asc.body.data.length - 1].dueDate);
  });

  it('rejects an unknown sort field and an out-of-range limit', async () => {
    await list(owner, owner.id, '?sortBy=passwordHash').expect(400);
    await list(owner, owner.id, '?limit=5000').expect(400);
    await list(owner, owner.id, '?page=0').expect(400);
  });

  it('excludes soft-deleted tasks unless explicitly asked', async () => {
    await seedTasks();
    const first = await list(owner, owner.id, '?limit=100').expect(200);
    const target = first.body.data[0];

    await api()
      .delete(`/api/v1/tasks/${target._id}`)
      .set('Authorization', manager.auth)
      .expect(204);

    const after = await list(owner, owner.id, '?limit=100').expect(200);
    expect(after.body.meta.total).toBe(11);

    const withDeleted = await list(owner, owner.id, '?limit=100&includeDeleted=true').expect(200);
    expect(withDeleted.body.meta.total).toBe(12);
  });

  it('enriches each row with assignee, creator and comment count', async () => {
    await seedTasks();
    const res = await list(owner, owner.id, '?limit=1').expect(200);
    const task = res.body.data[0];

    expect(task.assignees[0]).toMatchObject({ email: owner.email });
    expect(task.assignees[0]).not.toHaveProperty('passwordHash');
    expect(task.createdBy).toMatchObject({ email: manager.email });
    expect(task.commentCount).toBe(0);
  });

  it('lets a user list only their own tasks', async () => {
    await seedTasks();
    await list(other, owner.id).expect(403);
    await list(manager, owner.id).expect(200); // managers may list anyone's
  });
});

describe('response caching', () => {
  it('reports a miss then a hit for an identical query', async () => {
    await seedTasks();

    const miss = await list(owner, owner.id, '?limit=5').expect(200);
    expect(miss.headers['x-cache']).toBe('MISS');

    const hit = await list(owner, owner.id, '?limit=5').expect(200);
    expect(hit.headers['x-cache']).toBe('HIT');
    expect(hit.body).toEqual(miss.body);
  });

  it('keys the cache on the full query shape', async () => {
    await seedTasks();
    await list(owner, owner.id, '?limit=5').expect(200);

    // Different filter, so a different slot - must not serve the cached page.
    const other = await list(owner, owner.id, '?limit=5&status=done').expect(200);
    expect(other.headers['x-cache']).toBe('MISS');
  });

  it('invalidates on update, including for a write by another user', async () => {
    await seedTasks();
    const first = await list(owner, owner.id, '?limit=100').expect(200);
    expect(first.headers['x-cache']).toBe('MISS');
    await list(owner, owner.id, '?limit=100').expect(200); // now warm

    // The manager - not the cache's owner - performs the write.
    await api()
      .put(`/api/v1/tasks/${first.body.data[0]._id}`)
      .set('Authorization', manager.auth)
      .send({ title: 'Renamed by the manager' })
      .expect(200);

    const after = await list(owner, owner.id, '?limit=100').expect(200);
    expect(after.headers['x-cache']).toBe('MISS');
    expect(
      after.body.data.some((t: { title: string }) => t.title === 'Renamed by the manager'),
    ).toBe(true);
  });

  it('invalidates both the previous and the new assignee on reassignment', async () => {
    await seedTasks();
    const listing = await list(owner, owner.id, '?limit=100').expect(200);
    const taskId = listing.body.data[0]._id;

    await list(owner, owner.id, '?limit=100').expect(200); // warm owner
    await list(other, other.id, '?limit=100').expect(200);
    await list(other, other.id, '?limit=100').expect(200); // warm other

    await api()
      .put(`/api/v1/tasks/${taskId}`)
      .set('Authorization', manager.auth)
      .send({ assignees: [other.id] })
      .expect(200);

    // Both sides of the move must be re-read from the database.
    expect((await list(owner, owner.id, '?limit=100').expect(200)).headers['x-cache']).toBe('MISS');
    expect((await list(other, other.id, '?limit=100').expect(200)).headers['x-cache']).toBe('MISS');

    const otherTasks = await list(other, other.id, '?limit=100').expect(200);
    expect(otherTasks.body.data.some((t: { _id: string }) => t._id === taskId)).toBe(true);
  });

  it('invalidates on delete', async () => {
    await seedTasks();
    const first = await list(owner, owner.id, '?limit=100').expect(200);
    await list(owner, owner.id, '?limit=100').expect(200);

    await api()
      .delete(`/api/v1/tasks/${first.body.data[0]._id}`)
      .set('Authorization', manager.auth)
      .expect(204);

    const after = await list(owner, owner.id, '?limit=100').expect(200);
    expect(after.headers['x-cache']).toBe('MISS');
    expect(after.body.meta.total).toBe(11);
  });
});
