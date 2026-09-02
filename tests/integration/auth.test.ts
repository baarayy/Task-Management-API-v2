import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Role, User } from '../../src/models/index.js';
import { api, createTestUser, resetDb, startTestDb, stopTestDb } from '../helpers/app.js';

beforeAll(startTestDb);
afterAll(stopTestDb);
afterEach(resetDb);

describe('POST /api/v1/auth/register', () => {
  it('creates an account and returns a token pair', async () => {
    const res = await api()
      .post('/api/v1/auth/register')
      .send({ email: 'new@test.dev', password: 'ValidPass123', name: 'New User' })
      .expect(201);

    expect(res.body.user).toMatchObject({ email: 'new@test.dev', role: Role.User });
    expect(res.body.accessToken).toBeTypeOf('string');
    expect(res.body.refreshToken).toBeTypeOf('string');
    expect(res.body.user).not.toHaveProperty('passwordHash');
  });

  it('rejects a weak password with field-level detail', async () => {
    const res = await api()
      .post('/api/v1/auth/register')
      .send({ email: 'weak@test.dev', password: 'short', name: 'Weak' })
      .expect(400);

    expect(res.body.error.code).toBe('BAD_REQUEST');
    expect(res.body.error.details.some((d: { path: string }) => d.path === 'password')).toBe(true);
  });

  it('rejects a duplicate email', async () => {
    const payload = { email: 'dupe@test.dev', password: 'ValidPass123', name: 'Dupe' };
    await api().post('/api/v1/auth/register').send(payload).expect(201);
    await api().post('/api/v1/auth/register').send(payload).expect(409);
  });

  it('refuses to mint a privileged account through public registration', async () => {
    await api()
      .post('/api/v1/auth/register')
      .send({ email: 'sneaky@test.dev', password: 'ValidPass123', name: 'Sneak', role: 'admin' })
      .expect(403);
  });
});

describe('POST /api/v1/auth/login', () => {
  it('returns the same error for an unknown email and a wrong password', async () => {
    const user = await createTestUser();

    const unknown = await api()
      .post('/api/v1/auth/login')
      .send({ email: 'nobody@test.dev', password: 'TestPassword123' })
      .expect(401);
    const wrong = await api()
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: 'WrongPassword123' })
      .expect(401);

    // Identical messages: no account enumeration through the login endpoint.
    expect(unknown.body.error.message).toBe(wrong.body.error.message);
  });

  it('refuses a deactivated account', async () => {
    const user = await createTestUser();
    await User.updateOne({ _id: user.id }, { isActive: false });

    await api()
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: user.password })
      .expect(401);
  });
});

describe('POST /api/v1/auth/refresh', () => {
  it('rotates the refresh token and issues a new access token', async () => {
    const user = await createTestUser();

    const res = await api()
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: user.refreshToken })
      .expect(200);

    expect(res.body.refreshToken).not.toBe(user.refreshToken);
    await api()
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${res.body.accessToken}`)
      .expect(200);
  });

  it('detects reuse and revokes the whole token family', async () => {
    const user = await createTestUser();

    const rotated = await api()
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: user.refreshToken })
      .expect(200);

    // Replaying the consumed token is the signal that one of the two copies
    // is stolen. We cannot tell which, so the entire family is revoked.
    await api().post('/api/v1/auth/refresh').send({ refreshToken: user.refreshToken }).expect(401);

    // ...which means the legitimately rotated token is dead too.
    await api()
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: rotated.body.refreshToken })
      .expect(401);
  });

  it('rejects a forged token', async () => {
    await api().post('/api/v1/auth/refresh').send({ refreshToken: 'not.a.real.token' }).expect(401);
  });
});

describe('POST /api/v1/auth/logout', () => {
  it('kills every session when allDevices is set', async () => {
    const user = await createTestUser();

    await api()
      .post('/api/v1/auth/logout')
      .set('Authorization', user.auth)
      .send({ refreshToken: user.refreshToken, allDevices: true })
      .expect(204);

    // tokenVersion was bumped, so the still-unexpired access token is void.
    await api().get('/api/v1/auth/me').set('Authorization', user.auth).expect(401);
  });
});

describe('authentication middleware', () => {
  it('rejects a missing, malformed or invalid bearer token', async () => {
    await api().get('/api/v1/auth/me').expect(401);
    await api().get('/api/v1/auth/me').set('Authorization', 'Token abc').expect(401);
    await api().get('/api/v1/auth/me').set('Authorization', 'Bearer garbage').expect(401);
  });

  it('rejects a token for a user that no longer exists', async () => {
    const user = await createTestUser();
    await User.deleteOne({ _id: user.id });
    await api().get('/api/v1/auth/me').set('Authorization', user.auth).expect(401);
  });
});
