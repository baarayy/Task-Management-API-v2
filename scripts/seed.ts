/**
 * Loads the JSON fixtures in seed/ into MongoDB.
 *
 * Fixture ids are fixed rather than generated, so re-seeding is idempotent and
 * the documented curl examples keep working across runs.
 *
 *   npm run seed            # wipe and reload
 *   npm run seed -- --keep  # insert without wiping
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import argon2 from 'argon2';
import mongoose, { Types } from 'mongoose';
import { connectDb, disconnectDb } from '../src/lib/db.js';
import {
  Notification,
  Task,
  TaskComment,
  TaskHistory,
  User,
  UserTask,
} from '../src/models/index.js';

const seedDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'seed');
const read = <T>(file: string): T[] => JSON.parse(readFileSync(join(seedDir, file), 'utf8')) as T[];

/** Recursively converts 24-hex strings and ISO dates into BSON types. */
function hydrate(value: unknown): unknown {
  if (typeof value === 'string') {
    if (/^[0-9a-f]{24}$/i.test(value)) return new Types.ObjectId(value);
    if (/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(value)) return new Date(value);
    return value;
  }
  if (Array.isArray(value)) return value.map(hydrate);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, hydrate(v)]));
  }
  return value;
}

async function main(): Promise<void> {
  const keep = process.argv.includes('--keep');
  await connectDb();

  if (!keep) {
    await Promise.all([
      User.deleteMany({}),
      Task.deleteMany({}),
      UserTask.deleteMany({}),
      TaskHistory.deleteMany({}),
      TaskComment.deleteMany({}),
      Notification.deleteMany({}),
    ]);
    console.log('Cleared existing collections');
  }

  // Passwords live in the fixture in plaintext (they are throwaway demo
  // credentials) and are hashed here - never stored hashed in the repo.
  const rawUsers = read<Record<string, unknown>>('users.json');
  const users = await Promise.all(
    rawUsers.map(async (u) => {
      const { password, ...rest } = u as { password: string } & Record<string, unknown>;
      return {
        ...(hydrate(rest) as Record<string, unknown>),
        passwordHash: await argon2.hash(password, { type: argon2.argon2id }),
        tokenVersion: 0,
      };
    }),
  );
  await User.insertMany(users);

  await Task.insertMany(read('tasks.json').map(hydrate));
  await UserTask.insertMany(read('user_tasks.json').map(hydrate));
  await TaskHistory.insertMany(read('task_history.json').map(hydrate));
  await TaskComment.insertMany(read('task_comments.json').map(hydrate));
  await Notification.insertMany(read('notifications.json').map(hydrate));

  // Indexes are declared on the schemas; this forces them to exist now rather
  // than lazily, so the explain() output below is meaningful immediately.
  await Promise.all(mongoose.modelNames().map((m) => mongoose.model(m).syncIndexes()));

  const counts = {
    users: await User.countDocuments(),
    tasks: await Task.countDocuments(),
    user_tasks: await UserTask.countDocuments(),
    task_history: await TaskHistory.countDocuments(),
    task_comments: await TaskComment.countDocuments(),
    notifications: await Notification.countDocuments(),
  };

  console.table(counts);
  console.log('\nSeed complete. Demo credentials:');
  console.log('  admin@taskflow.dev   / AdminPass123    (admin)');
  console.log('  manager@taskflow.dev / ManagerPass123  (manager)');
  console.log('  dev1@taskflow.dev    / UserPass123     (user)');

  await disconnectDb();
}

main().catch(async (err) => {
  console.error(err);
  await disconnectDb().catch(() => undefined);
  process.exit(1);
});
