import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import argon2 from 'argon2';
import supertest, { type Agent } from 'supertest';
import { createApp } from '../../src/app.js';
import { Role, User, type RoleType } from '../../src/models/index.js';
import { redisMock } from './redisMock.js';

let replset: MongoMemoryReplSet | null = null;

/**
 * A single-node replica set rather than a standalone: the service layer uses
 * transactions, and only a replica set supports them - so tests exercise the
 * same code path as production.
 */
export async function startTestDb(): Promise<void> {
  replset = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  await mongoose.connect(replset.getUri(), { dbName: 'test' });
  await Promise.all(mongoose.modelNames().map((m) => mongoose.model(m).syncIndexes()));
}

export async function stopTestDb(): Promise<void> {
  await mongoose.connection.dropDatabase().catch(() => undefined);
  await mongoose.disconnect();
  await replset?.stop();
  replset = null;
}

export async function resetDb(): Promise<void> {
  const collections = await mongoose.connection.db?.collections();
  for (const collection of collections ?? []) await collection.deleteMany({});
  redisMock.flushall();
}

export const api = (): Agent => supertest(createApp()) as unknown as Agent;

export interface TestUser {
  id: string;
  email: string;
  password: string;
  role: RoleType;
  accessToken: string;
  refreshToken: string;
  auth: string;
}

/** Creates a user directly, then logs in through the API to get real tokens. */
export async function createTestUser(
  role: RoleType = Role.User,
  overrides: Partial<{ email: string; name: string; isActive: boolean }> = {},
): Promise<TestUser> {
  const email =
    overrides.email ?? `${role}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.dev`;
  const password = 'TestPassword123';

  const user = await User.create({
    email,
    name: overrides.name ?? `Test ${role}`,
    role,
    isActive: overrides.isActive ?? true,
    passwordHash: await argon2.hash(password, { type: argon2.argon2id }),
  });

  const res = await api().post('/api/v1/auth/login').send({ email, password }).expect(200);

  return {
    id: user._id.toString(),
    email,
    password,
    role,
    accessToken: res.body.accessToken,
    refreshToken: res.body.refreshToken,
    auth: `Bearer ${res.body.accessToken}`,
  };
}
