import express from 'express';
import rateLimit from 'express-rate-limit';
import supertest from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sanitizeValue, sanitizeRequest } from '../../src/middleware/sanitize.js';
import { Role, Task, User } from '../../src/models/index.js';
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

describe('input sanitization (unit)', () => {
  it('strips MongoDB operators and dotted paths', () => {
    const result = sanitizeValue({
      email: 'a@b.dev',
      password: { $ne: null },
      $where: 'sleep(5000)',
      'profile.role': 'admin',
    }) as Record<string, unknown>;

    expect(result).toEqual({ email: 'a@b.dev', password: {} });
    expect(result).not.toHaveProperty('$where');
    expect(result).not.toHaveProperty('profile.role');
  });

  it('strips HTML from free text', () => {
    const result = sanitizeValue({
      title: '<script>alert(1)</script>Release notes',
      body: '<img src=x onerror=alert(1)>',
    }) as Record<string, string>;

    expect(result.title).toBe('Release notes');
    expect(result.body).toBe('');
  });

  it('refuses prototype-polluting keys', () => {
    const result = sanitizeValue(JSON.parse('{"__proto__":{"admin":true},"ok":1}')) as Record<
      string,
      unknown
    >;
    expect(result).toEqual({ ok: 1 });
    expect(({} as Record<string, unknown>).admin).toBeUndefined();
  });

  it('recurses through arrays and nested objects', () => {
    const result = sanitizeValue({
      tags: ['<b>api</b>', 'infra'],
      nested: { deep: { $gt: '' }, keep: 'value' },
    }) as Record<string, unknown>;

    expect(result).toEqual({ tags: ['api', 'infra'], nested: { deep: {}, keep: 'value' } });
  });
});

describe('input sanitization (end to end)', () => {
  it('neutralises an operator-injection login attempt', async () => {
    const user = await createTestUser();

    // Without sanitization this shape can match any user in the collection.
    const res = await api()
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: { $ne: null } });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body).not.toHaveProperty('accessToken');
  });

  it('stores task text with markup removed', async () => {
    const manager = await createTestUser(Role.Manager);

    const res = await api()
      .post('/api/v1/tasks')
      .set('Authorization', manager.auth)
      .send({ title: '<script>alert("xss")</script>Quarterly review' })
      .expect(201);

    expect(res.body.title).toBe('Quarterly review');
    const stored = await Task.findById(res.body._id).lean();
    expect(stored?.title).not.toContain('<script>');
  });
});

describe('security headers and payload limits', () => {
  it('sets helmet headers and hides the framework', async () => {
    const res = await api().get('/health').expect(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('rejects an oversized body', async () => {
    const manager = await createTestUser(Role.Manager);
    await api()
      .post('/api/v1/tasks')
      .set('Authorization', manager.auth)
      .send({ title: 'x', description: 'y'.repeat(200_000) })
      .expect(413);
  });
});

describe('rate limiting', () => {
  /*
   * The application's limiters are inert under NODE_ENV=test (their counters
   * are module-level singletons and would bleed across cases), so the
   * behaviour is asserted here against an equivalently configured limiter.
   */
  it('returns 429 with the standard envelope once the window is exhausted', async () => {
    const app = express();
    app.use(express.json());
    app.use(
      rateLimit({
        windowMs: 60_000,
        max: 3,
        standardHeaders: 'draft-7',
        legacyHeaders: false,
        handler: (_req, res) =>
          res.status(429).json({
            error: {
              code: 'TOO_MANY_REQUESTS',
              message: 'Too many requests, please try again later',
            },
          }),
      }),
    );
    app.post('/login', (_req, res) => void res.status(200).json({ ok: true }));

    const client = supertest(app);
    for (let i = 0; i < 3; i += 1) await client.post('/login').expect(200);

    const blocked = await client.post('/login').expect(429);
    expect(blocked.body.error.code).toBe('TOO_MANY_REQUESTS');
    expect(blocked.headers).toHaveProperty('ratelimit');
  });

  it('applies the sanitizer before any handler sees the body', async () => {
    const app = express();
    app.use(express.json());
    app.use(sanitizeRequest);
    app.post('/echo', (req, res) => void res.json(req.body));

    const res = await supertest(app)
      .post('/echo')
      .send({ name: '<b>Bold</b>', $drop: true })
      .expect(200);

    expect(res.body).toEqual({ name: 'Bold' });
  });
});

describe('privilege escalation', () => {
  let admin: TestUser;
  let user: TestUser;

  beforeEach(async () => {
    admin = await createTestUser(Role.Admin);
    user = await createTestUser(Role.User);
  });

  it('blocks a non-admin from the user administration endpoints', async () => {
    await api()
      .post('/api/v1/users')
      .set('Authorization', user.auth)
      .send({
        email: 'x@test.dev',
        password: 'ValidPass123',
        name: 'X',
        role: 'admin',
      })
      .expect(403);

    await api()
      .patch(`/api/v1/users/${user.id}`)
      .set('Authorization', user.auth)
      .send({ role: 'admin' })
      .expect(403);
    await api().get('/api/v1/users').set('Authorization', user.auth).expect(403);
  });

  it('revokes live sessions when an admin changes a role', async () => {
    await api()
      .patch(`/api/v1/users/${user.id}`)
      .set('Authorization', admin.auth)
      .send({ role: Role.Manager })
      .expect(200);

    // The token issued under the old role must stop working immediately.
    await api().get('/api/v1/auth/me').set('Authorization', user.auth).expect(401);

    const fresh = await api()
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: user.password })
      .expect(200);
    expect(fresh.body.user.role).toBe(Role.Manager);
  });

  it('revokes sessions when an admin deactivates an account', async () => {
    await api()
      .patch(`/api/v1/users/${user.id}`)
      .set('Authorization', admin.auth)
      .send({ isActive: false })
      .expect(200);

    await api().get('/api/v1/auth/me').set('Authorization', user.auth).expect(401);
    expect((await User.findById(user.id).lean())?.isActive).toBe(false);
  });
});
